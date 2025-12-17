
import { GoogleGenAI, Type } from "@google/genai";
import { Account, AccountType, Transaction, TransactionStatus } from "../types";

// Helper to get AI instance safely
const getAI = () => {
  // L'API Key est injectée par Vite lors du build via 'define' dans vite.config.ts
  // Elle provient des Secrets GitHub (VITE_API_KEY)
  const apiKey = process.env.API_KEY;

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
 * AGENT 1: The Ingestion Agent
 * Uses Gemini Flash to extract data from PDF bank statements.
 * NOW ENHANCED: Takes matchedHistory to learn from user's past habits.
 */
export const parseBankStatementPDF = async (
  base64Pdf: string,
  existingAccounts: Account[],
  historyTransactions: Transaction[] = []
): Promise<{ transactions: any[], newAccounts: any[] }> => {
  const ai = getAI();
  
  // 1. Build a "Knowledge Base" from history
  // We take matched transactions, deduping by description to create a reference guide
  const knowledgeMap = new Map<string, string>(); // Description -> AccountCode
  
  // Sort by date desc to take most recent categorization
  const sortedHistory = [...historyTransactions].sort((a,b) => b.date.localeCompare(a.date));
  
  sortedHistory.forEach(t => {
      if (t.accountId && t.amount !== 0) {
          // Normalize description (shorten it slightly to capture patterns)
          const cleanDesc = t.description.trim().substring(0, 50); 
          const account = existingAccounts.find(a => a.id === t.accountId);
          if (account && !knowledgeMap.has(cleanDesc)) {
              knowledgeMap.set(cleanDesc, account.code);
          }
      }
  });

  // Convert map to a string for the prompt (limit to top 100 patterns to save tokens)
  const learningContext = Array.from(knowledgeMap.entries())
      .slice(0, 100)
      .map(([desc, code]) => `- "${desc}" was categorized as [${code}]`)
      .join("\n");

  const prompt = `
    You are an expert accounting assistant specialized in extracting data from bank statements (PDFs).
    
    CRITICAL INSTRUCTION:
    Extract EVERY SINGLE financial transaction row found in the document.
    DO NOT SUMMARIZE. DO NOT SKIP ANY ROW.
    If the document has 50 lines, output 50 transactions.
    
    For each transaction row found, identify:
    - Date (YYYY-MM-DD format)
    - Description (Libellé) - Keep the full text.
    - Amount (Ensure positive for credit/deposits, negative for debit/payments).
    
    MATCHING RULES (INTELLIGENT CATEGORIZATION):
    1. HISTORICAL LEARNING (PRIORITY): 
       Below is a list of how this user previously categorized similar transactions. 
       If a new transaction matches a description below, assign the same Account Code.
       
       ${learningContext ? `USER HISTORICAL DATA:\n${learningContext}` : "No history available yet."}

    2. ACCOUNT LIST MATCHING:
       If no historical match, match to the EXISTING ACCOUNTS provided below based on the description AND the sign.
       - Positive Amount (+) MUST match a 'PRODUIT' (Income) account.
       - Negative Amount (-) MUST match a 'CHARGE' (Expense) account.
    
    STRICT RULE: DO NOT suggest new accounts. If matchedAccountCode is unsure, set it to null.
    
    MEMBERSHIP:
    If the transaction matches an account marked for membership tracking (e.g. Cotisations, Camp), try to extract the person's name from the description.

    EXISTING ACCOUNTS JSON:
    ${JSON.stringify(existingAccounts.map(a => ({ code: a.code, label: a.label, type: a.type, isMembership: a.isMembership })))}

    Return the result strictly as JSON containing the full list of transactions.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: {
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
        { text: prompt }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          transactions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                date: { type: Type.STRING },
                description: { type: Type.STRING },
                amount: { type: Type.NUMBER },
                matchedAccountCode: { type: Type.STRING, description: "The code of the existing account if matched, otherwise null" },
                detectedMemberName: { type: Type.STRING, description: "Name of person if this is a membership fee" }
              }
            }
          }
        }
      }
    }
  });

  if (!response.text) return { transactions: [], newAccounts: [] };
  const parsed = JSON.parse(response.text);
  
  return {
    transactions: parsed.transactions || [],
    newAccounts: [] 
  };
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
