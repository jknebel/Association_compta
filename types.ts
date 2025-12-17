
export enum AccountType {
  INCOME = 'PRODUIT',
  EXPENSE = 'CHARGE',
  MIXED = 'MIXTE'
}

export interface Account {
  id: string;
  code: string;
  label: string;
  description: string;
  type: AccountType;
  isMembership: boolean; // Special flag for the mandatory membership account
  parentId?: string; // ID of the parent account for aggregation
  icon?: string; // Lucide icon name
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  REVIEW_NEEDED = 'REVIEW_NEEDED',
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED'
}

export interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number; // Positive for Credit (Income), Negative for Debit (Expense)
  accountId?: string;
  status: TransactionStatus;
  notes?: string;
  detectedMemberName?: string; // If extracted by AI
  receiptUrl?: string; // URL to the uploaded receipt image
}

export interface Receipt {
  id: string;
  url: string;
  fileName: string;
  uploadDate: string;
  extractedDate?: string;
  extractedAmount?: number;
  isAnalyzed: boolean;
  linkedTransactionId?: string;
}

export interface Member {
  id: string;
  name: string;
  hasPaid: boolean;
  paymentDate?: string;
  amountPaid: number;
}

export interface ProcessingResult {
  transactions: Transaction[];
  suggestedAccounts: Account[];
  logs: string[];
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  isThinking?: boolean;
}