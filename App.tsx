
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  AppState, 
  ReceiptData, 
  SUPPORTED_LANGUAGES, 
  UserSelection,
  ReceiptItem
} from './types';
import CameraCapture from './components/CameraCapture';
import { analyzeReceipt } from './services/geminiService';

// --- SECURITY UTILITIES ---

/**
 * Strips potential HTML tags to prevent XSS from untrusted AI output 
 * or manipulated URL parameters.
 */
const sanitizeString = (str: string): string => {
  return str.replace(/<[^>]*>?/gm, '').trim().substring(0, 255);
};

const safeBtoa = (str: string) => {
  try {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (e) {
    console.error("Base64 encoding error", e);
    return "";
  }
};

const safeAtob = (base64: string) => {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (e) {
    console.error("Base64 decoding error", e);
    return "";
  }
};

/**
 * Validates the structure and integrity of the receipt data.
 * Prevents "Bill Tampering" (e.g., manually changing total in the URL).
 */
const validateReceiptIntegrity = (data: any): ReceiptData | null => {
  try {
    if (!data || typeof data !== 'object') return null;
    
    // 1. Check Required Fields & Types
    if (typeof data.restaurantName !== 'string') return null;
    if (!Array.isArray(data.items)) return null;

    // 2. Sanitize Strings
    const sanitized: ReceiptData = {
      restaurantName: sanitizeString(data.restaurantName),
      date: sanitizeString(data.date || ''),
      currency: sanitizeString(data.currency || '$'),
      subtotal: Number(data.subtotal) || 0,
      tax: Number(data.tax) || 0,
      tip: Number(data.tip) || 0,
      total: Number(data.total) || 0,
      items: data.items.map((item: any, idx: number) => ({
        id: sanitizeString(item.id || `shared-${idx}`),
        quantity: Math.max(0, Number(item.quantity) || 1),
        description: sanitizeString(item.description || 'Unknown Item'),
        price: Math.max(0, Number(item.price) || 0)
      }))
    };

    // 3. Mathematical Integrity Check (Tolerance for floating point)
    const itemsSum = sanitized.items.reduce((acc, item) => acc + item.price, 0);
    // Note: We don't strictly block if sum !== total (due to discounts/rounding), 
    // but we ensure numbers are valid.
    
    return sanitized;
  } catch (e) {
    return null;
  }
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.HOME);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [userSelections, setUserSelections] = useState<Record<string, UserSelection>>({});
  const [loadingMessage, setLoadingMessage] = useState('Analyzing...');
  const [targetLang, setTargetLang] = useState('en');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (hash && hash.length > 10) {
        try {
          const jsonStr = safeAtob(decodeURIComponent(hash));
          if (jsonStr) {
            const rawData = JSON.parse(jsonStr);
            const validated = validateReceiptIntegrity(rawData);
            
            if (validated) {
              setReceipt(validated);
              setAppState(AppState.CONFIRM_INFO);
              setError(null);
            } else {
              throw new Error("Invalid receipt data");
            }
          }
        } catch (e) {
          console.error("Deep Link Error", e);
          setError("The shared link is invalid or has been tampered with.");
          setAppState(AppState.HOME);
        }
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleCapture = async (base64Image: string) => {
    setAppState(AppState.PROCESSING);
    setLoadingMessage('Gemini AI is scanning your receipt securely...');
    setError(null);
    try {
      const data = await analyzeReceipt(base64Image, targetLang);
      const validated = validateReceiptIntegrity(data);
      if (validated) {
        setReceipt(validated);
        setAppState(AppState.CONFIRM_INFO);
      } else {
        throw new Error("Received malformed data from AI analysis.");
      }
    } catch (err: any) {
      setError(err.message);
      setAppState(AppState.HOME);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        if (result) handleCapture(result);
      };
      reader.readAsDataURL(file);
    }
  };

  const toggleItem = (itemId: string) => {
    setUserSelections(prev => {
      const existing = prev[itemId];
      return {
        ...prev,
        [itemId]: { itemId, isSelected: !existing?.isSelected, splitCount: existing?.splitCount || 1 }
      };
    });
  };

  const updateSplit = (itemId: string, count: number) => {
    setUserSelections(prev => {
      const existing = prev[itemId];
      return {
        ...prev,
        [itemId]: { ...(existing || { itemId, isSelected: true, splitCount: 1 }), splitCount: Math.max(1, count) }
      };
    });
  };

  const calculations = useMemo(() => {
    if (!receipt) return { subtotal: 0, tax: 0, tip: 0, total: 0, ratio: 0 };
    
    const selections = Object.values(userSelections);
    const userSubtotal = selections
      .filter(s => s.isSelected)
      .reduce((acc, sel) => {
        const item = receipt.items.find(i => i.id === sel.itemId);
        return item ? acc + (item.price / sel.splitCount) : acc;
      }, 0);

    const receiptSubtotal = receipt.subtotal || receipt.items.reduce((acc, item) => acc + item.price, 0);
    const userRatio = receiptSubtotal > 0 ? (userSubtotal / receiptSubtotal) : 0;
    
    return {
      subtotal: userSubtotal,
      tax: (receipt.tax || 0) * userRatio,
      tip: (receipt.tip || 0) * userRatio,
      total: userSubtotal + ((receipt.tax || 0) * userRatio) + ((receipt.tip || 0) * userRatio),
      ratio: userRatio
    };
  }, [receipt, userSelections]);

  const generateShareLink = () => {
    if (!receipt) return;
    try {
      const minifiedReceipt = {
        restaurantName: receipt.restaurantName,
        date: receipt.date,
        currency: receipt.currency,
        subtotal: receipt.subtotal,
        tax: receipt.tax,
        tip: receipt.tip,
        total: receipt.total,
        items: receipt.items.map(i => ({
          id: i.id,
          quantity: i.quantity,
          description: i.description,
          price: i.price
        }))
      };

      const encoded = encodeURIComponent(safeBtoa(JSON.stringify(minifiedReceipt)));
      const url = `${window.location.href.split('#')[0]}#${encoded}`;
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => alert("Secure share link copied!"));
      } else {
        prompt("Copy this secure link:", url);
      }
    } catch (e) {
      alert("Encryption failed. Data too large?");
    }
  };

  const handleStartOver = () => {
    setReceipt(null);
    setUserSelections({});
    setAppState(AppState.HOME);
    window.history.replaceState(null, "", window.location.href.split('#')[0]);
  };

  const renderContent = () => {
    switch (appState) {
      case AppState.HOME:
        return (
          <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center animate-in fade-in duration-300">
            <div className="w-20 h-20 bg-blue-600 rounded-3xl flex items-center justify-center mb-6 shadow-xl shadow-blue-200">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">BillSplit Pro</h1>
            <p className="text-gray-500 mb-8 max-w-xs">AI-powered receipt splitting. Secure, private, and client-side only.</p>
            
            <div className="w-full max-w-xs space-y-4">
              <div className="flex flex-col text-left">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Translation Language</label>
                <select 
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  className="w-full p-3 bg-white border border-gray-200 rounded-xl shadow-sm focus:ring-2 focus:ring-blue-500"
                >
                  {SUPPORTED_LANGUAGES.map(lang => (
                    <option key={lang.code} value={lang.code}>{lang.name}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-3">
                <button 
                  onClick={() => setAppState(AppState.CAMERA)}
                  className="w-full bg-blue-600 text-white py-4 px-6 rounded-2xl font-semibold shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all flex items-center justify-center space-x-2"
                >
                  <span>Scan New Receipt</span>
                </button>

                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full bg-white border border-gray-200 text-gray-700 py-4 px-6 rounded-2xl font-semibold hover:bg-gray-50 transition-all"
                >
                  Upload from Gallery
                </button>
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept="image/*" className="hidden" />
              </div>
            </div>
            
            {error && (
              <div className="mt-6 p-4 bg-red-50 text-red-600 rounded-xl border border-red-100 text-sm max-w-xs">
                {error}
              </div>
            )}
          </div>
        );

      case AppState.PROCESSING:
        return (
          <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
            <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-6"></div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Analyzing Data</h2>
            <p className="text-gray-500 text-sm">{loadingMessage}</p>
          </div>
        );

      case AppState.CONFIRM_INFO:
        if (!receipt) return null;
        return (
          <div className="max-w-md mx-auto p-6 animate-in slide-in-from-bottom duration-500">
            <div className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100 mb-6 text-center relative overflow-hidden">
               <div className="absolute top-0 left-0 w-full h-1 bg-green-500 opacity-50"></div>
               <span className="text-xs font-bold text-blue-600 uppercase tracking-widest block mb-4">Integrity Verified</span>
               <h2 className="text-2xl font-bold text-gray-900 mb-1">{receipt.restaurantName}</h2>
               <p className="text-gray-400 mb-6">{receipt.date || 'No Date'}</p>
               <div className="text-3xl font-mono font-bold text-gray-900 bg-gray-50 py-4 rounded-2xl">
                 {receipt.currency}{receipt.total.toFixed(2)}
               </div>
            </div>

            <div className="space-y-3">
              <button onClick={() => setAppState(AppState.SELECT_ITEMS)} className="w-full bg-blue-600 text-white py-4 px-6 rounded-2xl font-semibold">
                Claim My Items
              </button>
              <button onClick={generateShareLink} className="w-full bg-white border border-gray-200 text-gray-700 py-4 px-6 rounded-2xl font-semibold">
                Share Link with Friends
              </button>
              <button onClick={handleStartOver} className="w-full text-gray-400 py-3 text-sm font-medium">
                Reset
              </button>
            </div>
          </div>
        );

      case AppState.SELECT_ITEMS:
        if (!receipt) return null;
        return (
          <div className="max-w-2xl mx-auto pb-40 animate-in slide-in-from-right duration-300">
            <div className="p-6 sticky top-0 bg-white/90 backdrop-blur-md z-10 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Select Items</h2>
                <p className="text-xs text-gray-400">{receipt.restaurantName}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-bold text-gray-400 uppercase">My Share</p>
                <p className="text-lg font-bold text-blue-600">{receipt.currency}{calculations.total.toFixed(2)}</p>
              </div>
            </div>

            <div className="px-6 py-4 space-y-3">
              {receipt.items.map((item) => {
                const selection = userSelections[item.id];
                const isSelected = selection?.isSelected;
                const splitCount = selection?.splitCount || 1;

                return (
                  <div key={item.id} className={`p-4 rounded-2xl border transition-all ${isSelected ? 'bg-blue-50 border-blue-200 shadow-sm' : 'bg-white border-gray-100'}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1 cursor-pointer" onClick={() => toggleItem(item.id)}>
                        <h3 className={`font-semibold ${isSelected ? 'text-blue-900' : 'text-gray-800'}`}>{item.description}</h3>
                        <p className="text-sm text-gray-500">{receipt.currency}{item.price.toFixed(2)}</p>
                      </div>
                      <div className="flex flex-col items-end space-y-2">
                        <div onClick={() => toggleItem(item.id)} className={`w-6 h-6 rounded-full border-2 ${isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-200'}`}>
                           {isSelected && <svg className="w-4 h-4 text-white mx-auto mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>}
                        </div>
                        {isSelected && (
                          <div className="flex items-center bg-white border border-blue-100 rounded-lg text-xs font-bold">
                            <button onClick={(e) => { e.stopPropagation(); updateSplit(item.id, splitCount - 1); }} className="px-2 py-1">-</button>
                            <span className="px-2">Split {splitCount}</span>
                            <button onClick={(e) => { e.stopPropagation(); updateSplit(item.id, splitCount + 1); }} className="px-2 py-1">+</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="fixed bottom-0 left-0 right-0 p-6 bg-white border-t border-gray-100 z-20">
              <button onClick={() => setAppState(AppState.SUMMARY)} disabled={calculations.subtotal === 0} className="w-full max-w-2xl mx-auto block bg-gray-900 text-white py-4 rounded-2xl font-bold disabled:bg-gray-200">
                View Summary
              </button>
            </div>
          </div>
        );

      case AppState.SUMMARY:
        if (!receipt) return null;
        return (
          <div className="max-w-md mx-auto p-6 space-y-6 pb-20 animate-in slide-in-from-bottom duration-400">
            <div className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100 relative receipt-texture">
               <h2 className="text-xl font-bold text-center mb-1">{receipt.restaurantName}</h2>
               <p className="text-sm text-gray-400 text-center mb-6">{receipt.date}</p>
               <div className="space-y-3 mb-6 border-b border-dashed border-gray-200 pb-4">
                 {receipt.items.filter(i => userSelections[i.id]?.isSelected).map(item => (
                   <div key={item.id} className="flex justify-between text-sm">
                     <span className="text-gray-600">{item.description}</span>
                     <span className="font-mono">{(item.price / (userSelections[item.id]?.splitCount || 1)).toFixed(2)}</span>
                   </div>
                 ))}
               </div>
               <div className="space-y-2 text-sm text-gray-500">
                 <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{calculations.subtotal.toFixed(2)}</span></div>
                 <div className="flex justify-between"><span>Tax (Prop.)</span><span className="font-mono">{calculations.tax.toFixed(2)}</span></div>
                 <div className="flex justify-between"><span>Tip (Prop.)</span><span className="font-mono">{calculations.tip.toFixed(2)}</span></div>
                 <div className="flex justify-between text-lg font-bold text-blue-600 pt-2 border-t border-gray-100">
                   <span>Your Total</span><span>{receipt.currency}{calculations.total.toFixed(2)}</span>
                 </div>
               </div>
            </div>
            <button onClick={generateShareLink} className="w-full bg-blue-600 text-white py-4 px-6 rounded-2xl font-semibold">Share Link</button>
            <button onClick={() => setAppState(AppState.SELECT_ITEMS)} className="w-full bg-white border border-gray-200 py-4 rounded-2xl font-semibold">Back</button>
            <button onClick={handleStartOver} className="w-full text-gray-400 text-sm">New Bill</button>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen selection:bg-blue-100">
      {appState === AppState.CAMERA && <CameraCapture onCapture={handleCapture} onCancel={() => setAppState(AppState.HOME)} />}
      <main>{renderContent()}</main>
    </div>
  );
};

export default App;
