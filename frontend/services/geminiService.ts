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
  // Only send unlinked transactions with minimal fields for matching
  const minimalTxns = transactions
    .filter(t => !t.receiptUrl)
    .map(({ id, date, description, amount, notes, receiptUrl }) =>
      ({ id, date, description, amount, notes, receiptUrl }));
  formData.append('transactions', JSON.stringify(minimalTxns));

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

/**
 * AGENT 1: The Ingestion Agent (SERVER-SIDE)
 * Sends the PDF to the Python Backend for processing via LangGraph.
 */
export const parseBankStatementPDF = async (
  base64Pdf: string,
  existingAccounts: Account[],
  historyTransactions: Transaction[] = [],
  userId: string = "guest",
  globalContext: string = ""
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
  formData.append('context', globalContext);

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
 * Helper to normalize LLM text (handles string or array of content blocks from LangChain)
 */
function normalizeLlmText(raw: any): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (item.type === "text" && typeof item.text === "string") return item.text;
          if (item.type !== "thinking" && typeof item.text === "string") return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return String(raw).trim();
}

/**
 * Generates a complete local fallback audit report if backend is unavailable or returns empty
 */
function generateLocalFallbackAudit(transactions: Transaction[], accounts: Account[]): string {
  const incomeTxns = transactions.filter(t => t.amount > 0);
  const expenseTxns = transactions.filter(t => t.amount < 0);
  const totalIncome = incomeTxns.reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = expenseTxns.reduce((sum, t) => sum + t.amount, 0);
  const netResult = totalIncome + totalExpense;

  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const anomalies: string[] = [];

  // 1. Check uncategorized
  const uncategorized = transactions.filter(t => !t.accountId || !accountMap.has(t.accountId));
  if (uncategorized.length > 0) {
    anomalies.push(`- **Transactions non catégorisées (${uncategorized.length})** : Certaines écritures n'ont pas de compte valide attribué.`);
  }

  // 2. Check polarity mismatches
  const polarityMismatches = transactions.filter(t => {
    if (!t.accountId) return false;
    const acc = accountMap.get(t.accountId);
    if (!acc) return false;
    if (t.amount > 0 && acc.type === "CHARGE") return true;
    if (t.amount < 0 && acc.type === "PRODUIT") return true;
    return false;
  });
  if (polarityMismatches.length > 0) {
    polarityMismatches.slice(0, 10).forEach(t => {
      const acc = accountMap.get(t.accountId!);
      anomalies.push(`- **Incohérence de sens** : \`${t.date}\` — *${t.description}* (${t.amount.toFixed(2)} CHF) est affectée au compte **${acc?.code} - ${acc?.label}** (${acc?.type}).`);
    });
  }

  // 3. Large expenses without receipt (> 200 CHF)
  const largeExpensesWithoutReceipt = expenseTxns.filter(t => Math.abs(t.amount) >= 200 && !t.receiptUrl);
  if (largeExpensesWithoutReceipt.length > 0) {
    anomalies.push(`- **Dépenses importantes (≥ 200 CHF) sans pièce justificative liée (${largeExpensesWithoutReceipt.length})** :`);
    largeExpensesWithoutReceipt.slice(0, 8).forEach(t => {
      anomalies.push(`  - \`${t.date}\` — *${t.description}* : **${t.amount.toFixed(2)} CHF**`);
    });
    if (largeExpensesWithoutReceipt.length > 8) {
      anomalies.push(`  - *...et ${largeExpensesWithoutReceipt.length - 8} autre(s) dépense(s) ≥ 200 CHF sans justificatif.*`);
    }
  }

  // 4. Potential duplicates (same date, same amount, same description)
  const seen = new Map<string, Transaction>();
  const duplicates: Transaction[] = [];
  transactions.forEach(t => {
    const key = `${t.date}|${t.amount.toFixed(2)}|${(t.description || '').trim().toLowerCase()}`;
    if (seen.has(key)) {
      duplicates.push(t);
    } else {
      seen.set(key, t);
    }
  });
  if (duplicates.length > 0) {
    anomalies.push(`- **Doublons potentiels détectés (${duplicates.length})** : Même date, même montant et même libellé.`);
    duplicates.slice(0, 5).forEach(t => {
      anomalies.push(`  - \`${t.date}\` — *${t.description}* (${t.amount.toFixed(2)} CHF)`);
    });
  }

  const today = new Date().toLocaleDateString('fr-CH');
  const situation = netResult >= 0 ? `**bénéficiaire** (+${netResult.toFixed(2)} CHF)` : `**déficitaire** (${netResult.toFixed(2)} CHF)`;

  return [
    `### 1. Synthèse Financière`,
    `L'exercice comptable analysé porte sur **${transactions.length} écritures** réparties sur **${accounts.length} comptes**.`,
    `- **Total des Produits (Recettes)** : **+${totalIncome.toFixed(2)} CHF** (${incomeTxns.length} écritures)`,
    `- **Total des Charges (Dépenses)** : **${totalExpense.toFixed(2)} CHF** (${expenseTxns.length} écritures)`,
    `- **Résultat Net de l'exercice** : Situation ${situation}`,
    ``,
    `### 2. ⚠️ Points de Vigilance & Contrôle des Écritures`,
    anomalies.length > 0
      ? anomalies.join('\n')
      : `✅ **R.A.S — Comptabilité cohérente.** Toutes les transactions sont correctement catégorisées et aucune anomalie de sens n'a été détectée.`,
    ``,
    `### 3. Certification`,
    `> *Je, soussigné l'Assistant d'Audit Comptable, certifie la cohérence arithmétique de ces ${transactions.length} écritures au ${today}.*`
  ].join('\n');
}

/**
 * AGENT 2: The Expert Auditor
 * Calls the backend to generate a formal audit report.
 */
export const auditLedger = async (
  transactions: Transaction[],
  accounts: Account[]
): Promise<string> => {
  try {
    // Sanitize payload to match backend Pydantic schema cleanly
    const cleanTransactions = transactions.map(t => ({
      id: String(t.id || ''),
      date: String(t.date || ''),
      description: String(t.description || ''),
      simplifiedDescription: t.simplifiedDescription || null,
      amount: Number(t.amount || 0),
      fullRawText: t.fullRawText || null,
      notes: t.notes || null,
      accountId: t.accountId || null,
      status: String(t.status || 'APPROVED'),
      detectedMemberName: t.detectedMemberName || null,
      receiptUrl: t.receiptUrl || null,
      receiptFileName: t.receiptFileName || null
    }));

    const cleanAccounts = accounts.map(a => ({
      id: String(a.id || ''),
      code: String(a.code || ''),
      label: String(a.label || ''),
      type: String(a.type || 'CHARGE'),
      parentId: a.parentId || null,
      description: a.description || null,
      isMembership: Boolean(a.isMembership),
      iaContext: a.iaContext || null,
      initialBalance: Number(a.initialBalance || 0),
      closingBalance: a.closingBalance !== undefined && a.closingBalance !== null ? Number(a.closingBalance) : null
    }));

    const result = await callApi<{ report: any }>("/audit", {
      transactions: cleanTransactions,
      accounts: cleanAccounts
    });
    const text = normalizeLlmText(result?.report);
    if (text) {
      return text;
    }
    return generateLocalFallbackAudit(transactions, accounts);
  } catch (error) {
    console.error("Audit Backend Call Failed, using local audit engine:", error);
    return generateLocalFallbackAudit(transactions, accounts);
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
    const result = await callApi<{ response: any }>("/chat", {
      history,
      context: currentContext,
      newMessage
    });
    return normalizeLlmText(result?.response) || "Je n'ai pas pu générer de réponse.";
  } catch (error) {
    console.error("Chat Failed:", error);
    return "Désolé, je ne peux pas répondre pour le moment (Erreur backend).";
  }
};

/**
 * Helper to auto-categorize a single transaction description
 */
export const suggestCategory = async (description: string, accounts: Account[], fullRawText?: string, receiptFileName?: string): Promise<{ accountId: string | null, memberName?: string | null }> => {
  try {
    const result = await callApi<{ accountId: string | null, memberName?: string | null }>("/suggest-category", {
      description,
      accounts,
      fullRawText,
      receiptFileName
    });
    return result;
  } catch (error) {
    console.error("Suggest Category Failed:", error);
    return { accountId: null };
  }
};

