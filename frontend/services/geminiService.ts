/// <reference types="vite/client" />
import { Account, Transaction } from "../../types";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

/**
 * Helper for API calls
 */
async function callApi<T>(endpoint: string, body: any): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend Error (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * AGENT: Receipt Analyzer
 * Extracts Date and Total Amount from a receipt image/pdf
 */
export const analyzeReceipt = async (base64Data: string, mimeType: string): Promise<{ date?: string, amount?: number }> => {
  try {
    return await callApi("/analyze-receipt", { base64Data, mimeType });
  } catch (error) {
    console.error("Receipt Analysis Failed:", error);
    return {};
  }
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
  historyTransactions: Transaction[] = [], // Not used in new backend flow (handled by backend DB lookup) but kept for signature compat
  userId: string = "guest"
): Promise<{ transactions: any[], newAccounts: any[] }> => {

  // Create Form Data (Specific handling for file upload)
  const formData = new FormData();

  // Convert Base64 back to Blob
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
 * Calls the backend to generate a formal audit report.
 */
export const auditLedger = async (
  transactions: Transaction[],
  accounts: Account[]
): Promise<string> => {
  try {
    const result = await callApi<{ report: string }>("/audit", {
      transactions,
      accounts
    });
    return result.report;
  } catch (error) {
    console.error("Audit Failed:", error);
    return "Erreur lors de la génération de l'audit. Veuillez vérifier que le backend est bien lancé.";
  }
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
  try {
    const result = await callApi<{ response: string }>("/chat", {
      history,
      context: currentContext,
      newMessage
    });
    return result.response;
  } catch (error) {
    console.error("Chat Failed:", error);
    return "Désolé, je ne peux pas répondre pour le moment (Erreur backend).";
  }
};

/**
 * Helper to auto-categorize a single transaction description
 */
export const suggestCategory = async (description: string, accounts: Account[]): Promise<{ accountId: string | null, memberName?: string | null }> => {
  try {
    const result = await callApi<{ accountId: string | null, memberName?: string | null }>("/suggest-category", {
      description,
      accounts
    });
    return result;
  } catch (error) {
    console.error("Suggest Category Failed:", error);
    return { accountId: null };
  }
};

