/// <reference types="vite/client" />

import { GoogleGenAI, Type } from "@google/genai";
import { Account, AccountType, Transaction, TransactionStatus } from "../../types";

// Helper to get AI instance safely
const getAI = () => {
  // L'API Key est injectée par Vite (VITE_API_KEY)
  const apiKey = import.meta.env.VITE_API_KEY;

  if (!apiKey) {
    throw new Error("API Key is missing. Check your .env file or GitHub Secrets configuration.");
  }
  return new GoogleGenAI({ apiKey });
};

/**
 * AGENT: Receipt Analyzer
 * Extracts Date and Total Amount from a receipt image/pdf
 */
export const analyzeReceipt = async (base64Data: string, mimeType: string): Promise<{ date?: string, amount?: number }> => {
  const ai = getAI();

  const prompt = `
      Analyze this receipt/invoice.
      Extract:
      1. The date of the transaction (Format YYYY-MM-DD).
      2. The TOTAL amount (Float).
      
      If you cannot find one of them, return null for that field.
      Return JSON only.
    `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: {
      parts: [
        { inlineData: { mimeType: mimeType, data: base64Data } },
        { text: prompt }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          date: { type: Type.STRING, nullable: true },
          amount: { type: Type.NUMBER, nullable: true }
        }
      }
    }
  });

  if (!response.text) return {};
  return JSON.parse(response.text);
};

/**
 * AGENT: Automated Receipt Verification via Python Backend
 */
export const processReceiptBackend = async (
  base64Data: string,
  mimeType: string,
  transactions: Transaction[]
): Promise<{ extracted: { date?: string, amount?: number, content?: string }, matchedTransactionId: string | null }> => {
  const formData = new FormData();

  // Convert Base64 back to Blob
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });

  formData.append('file', blob, 'receipt.bin');
  formData.append('transactions', JSON.stringify(transactions));

  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000";

  try {
    const response = await fetch(`${apiUrl}/process-receipt`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server Error: ${response.status} - ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error("API Call processReceipt Failed:", error);
    throw error;
  }
};

/**
 * AGENT 1: The Ingestion Agent
 * Uses Gemini Flash to extract data from PDF bank statements.
 * NOW ENHANCED: Takes matchedHistory to learn from user's past habits.
 */
// --- API CONFIGURATION ---
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

/**
 * AGENT 1: The Ingestion Agent (SERVER-SIDE)
 * Sends the PDF to the Python Backend for processing via LangGraph.
 */
export const parseBankStatementPDF = async (
  base64Pdf: string,
  existingAccounts: Account[],
  historyTransactions: Transaction[] = [],
  userId: string = "guest" // Fallback for guest mode
): Promise<{ transactions: any[], newAccounts: any[] }> => {

  // Create Form Data
  const formData = new FormData();

  // Convert Base64 back to Blob for upload (efficient handling)
  const byteCharacters = atob(base64Pdf);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: 'application/pdf' });

  formData.append('file', blob, 'statement.pdf');
  formData.append('accounts', JSON.stringify(existingAccounts));
  formData.append('userId', userId);

  try {
    const response = await fetch(`${API_URL}/process-bank-statement`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Server Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log("Backend Logs:", data.logs);

    return {
      transactions: data.transactions || [],
      newAccounts: []
    };
  } catch (error) {
    console.error("API Call Failed:", error);
    throw error;
  }
};

/**
 * AGENT 2: The Expert Auditor
 * Uses Gemini 3 Pro with Thinking Budget to audit the books.
 */
export const auditLedger = async (
  transactions: Transaction[],
  accounts: Account[]
): Promise<string> => {
  const ai = getAI();

  const prompt = `
    You are a Senior Expert Accountant (Expert Comptable) for a non-profit association.
    
    Review the following ledger of transactions and chart of accounts.
    Your goal is to find errors, inconsistencies, or missing information.
    
    CHECK FOR:
    1. Transactions mapped to the wrong account type (e.g., negative amount in a Revenue account).
    2. Membership fees that are missing a detected member name.
    3. Duplicate entries.
    4. Uncategorized transactions (missing Account ID).
    5. Unusually high amounts or suspicious descriptions.
    
    Provide a detailed report in HTML format (using simple tags like <b>, <ul>, <li>, <p>) summarizing your findings and recommending corrections.
    Be professional, thorough, and helpful.

    ACCOUNTS:
    ${JSON.stringify(accounts)}

    TRANSACTIONS:
    ${JSON.stringify(transactions)}
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: prompt,
    config: {
      thinkingConfig: { thinkingBudget: 16000 }, // Allocate thinking budget for complex reasoning
    }
  });

  return response.text || "No analysis generated.";
};

/**
 * AGENT 3: The Conversational Assistant
 * Chat with context of the current financial state.
 */
export const chatWithAccountant = async (
  history: { role: 'user' | 'model', text: string }[],
  currentContext: { transactions: Transaction[], accounts: Account[] },
  newMessage: string
) => {
  const ai = getAI();

  // Create chat session with context in system instruction
  const chat = ai.chats.create({
    model: 'gemini-3-pro-preview',
    config: {
      systemInstruction: `
        You are an intelligent accounting assistant for an association.
        You have access to the current financial data:
        ${JSON.stringify(currentContext.accounts.length)} accounts and ${JSON.stringify(currentContext.transactions.length)} transactions.
        
        Total Income: ${currentContext.transactions.filter(t => t.amount > 0).reduce((acc, t) => acc + t.amount, 0)}
        Total Expenses: ${currentContext.transactions.filter(t => t.amount < 0).reduce((acc, t) => acc + t.amount, 0)}
        
        Answer questions about the finances, help categorize items, or explain accounting principles.
        If asked to perform an action (like "create an account"), guide the user on how to do it in the UI.
      `,
      thinkingConfig: { thinkingBudget: 8192 }
    },
    history: history.map(h => ({
      role: h.role,
      parts: [{ text: h.text }]
    }))
  });

  const response = await chat.sendMessage({ message: newMessage });
  return response.text;
};

/**
 * Helper to auto-categorize a single transaction description using RAG-like context
 */
export const suggestCategory = async (description: string, accounts: Account[]) => {
  const ai = getAI();
  const prompt = `
    Given the description "${description}", which of the following accounts is the best fit?
    Accounts: ${JSON.stringify(accounts.map(a => ({ id: a.id, label: a.label })))}
    Return only the ID of the matching account, or "null" if unknown.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt
  });

  const text = response.text?.trim();
  return text === 'null' ? null : text;
};
