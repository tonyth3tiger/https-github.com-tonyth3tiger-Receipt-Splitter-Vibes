
export interface ReceiptItem {
  id: string;
  quantity: number;
  description: string;
  price: number;
  originalDescription?: string;
}

export interface ReceiptData {
  restaurantName: string;
  date: string;
  items: ReceiptItem[];
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  currency: string;
}

export interface UserSelection {
  itemId: string;
  splitCount: number; // 1 means full, 2 means split by 2, etc.
  isSelected: boolean;
}

export enum AppState {
  HOME = 'HOME',
  CAMERA = 'CAMERA',
  PROCESSING = 'PROCESSING',
  CONFIRM_INFO = 'CONFIRM_INFO',
  SELECT_ITEMS = 'SELECT_ITEMS',
  SUMMARY = 'SUMMARY'
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' }
];
