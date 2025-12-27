
import { GoogleGenAI, Type } from "@google/genai";
import { ReceiptData } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

const receiptSchema = {
  type: Type.OBJECT,
  properties: {
    restaurantName: { type: Type.STRING, description: "Name of the restaurant" },
    date: { type: Type.STRING, description: "Date of the meal in YYYY-MM-DD format" },
    currency: { type: Type.STRING, description: "Currency symbol or code found on receipt" },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          quantity: { type: Type.NUMBER },
          description: { type: Type.STRING },
          price: { type: Type.NUMBER }
        },
        required: ["quantity", "description", "price"]
      }
    },
    subtotal: { type: Type.NUMBER, description: "Sum of item prices before tax and tip" },
    tax: { type: Type.NUMBER, description: "Sales tax or VAT amount" },
    tip: { type: Type.NUMBER, description: "Gratuity, tip, or service charge amount if found" },
    total: { type: Type.NUMBER, description: "The final total amount on the receipt" }
  },
  required: ["restaurantName", "items", "total"]
};

export const analyzeReceipt = async (base64Image: string, targetLanguage: string): Promise<ReceiptData> => {
  const model = 'gemini-3-flash-preview';
  
  const prompt = `
    Analyze this restaurant receipt. 
    1. Extract the restaurant name and date.
    2. Extract all line items (quantity, description, price).
    3. Identify subtotal, tax, tip (if present), and the grand total.
    4. If the tip is not a separate line but part of the total, try to derive it or mark as 0 if unknown.
    5. Translate the 'description' of all items into ${targetLanguage} if the original language is different.
    6. Return the result in the specified JSON format.
  `;

  const imagePart = {
    inlineData: {
      mimeType: "image/jpeg",
      data: base64Image.split(',')[1] // Remove data:image/jpeg;base64,
    }
  };

  try {
    const response = await ai.models.generateContent({
      model,
      contents: { parts: [imagePart, { text: prompt }] },
      config: {
        responseMimeType: "application/json",
        responseSchema: receiptSchema,
      }
    });

    const parsedData = JSON.parse(response.text || '{}');
    
    // Add unique IDs to items
    return {
      ...parsedData,
      tip: parsedData.tip || 0,
      tax: parsedData.tax || 0,
      subtotal: parsedData.subtotal || 0,
      items: (parsedData.items || []).map((item: any, index: number) => ({
        ...item,
        id: `item-${index}-${Date.now()}`
      }))
    };
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    throw new Error("Failed to analyze receipt. Please ensure the photo is clear.");
  }
};
