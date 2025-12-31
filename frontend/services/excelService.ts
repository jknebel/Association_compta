import * as XLSX from 'xlsx';
import { Account, Transaction, AccountType, TransactionStatus } from '../../types';

/**
 * Generates a full accounting report (Bilan + Journal)
 * Aggregates Sub-Accounts into Parent Accounts for the Bilan sheet.
 */
export const generateAccountingReport = (transactions: Transaction[], accounts: Account[]) => {
  const wb = XLSX.utils.book_new();

  // --- SHEET 1: BILAN (Summary) ---

  // 1. Initialize a map for all accounts to hold totals
  const totalsMap = new Map<string, { income: number, expense: number, balance: number }>();

  accounts.forEach(acc => {
    totalsMap.set(acc.id, { income: 0, expense: 0, balance: 0 });
  });

  // 2. Sum transactions per DIRECT account (Leaf nodes)
  transactions.forEach(t => {
    if (t.accountId && totalsMap.has(t.accountId)) {
      const current = totalsMap.get(t.accountId)!;
      current.balance += t.amount;
      if (t.amount > 0) current.income += t.amount;
      else current.expense += t.amount;
    }
  });

  // 3. Roll up Child totals into Parents
  // We first identify children and add their values to their parent
  const processedMap = new Map<string, { income: number, expense: number, balance: number }>();

  // Initialize processed map with direct totals first
  accounts.forEach(acc => {
    const direct = totalsMap.get(acc.id)!;
    processedMap.set(acc.id, { ...direct });
  });

  // Now aggregate children into parents
  accounts.forEach(acc => {
    if (acc.parentId) {
      // It's a child. Add its totals to the parent in the PROCESSED map
      const parentTotals = processedMap.get(acc.parentId);
      const childTotals = totalsMap.get(acc.id); // Take direct totals of child

      if (parentTotals && childTotals) {
        parentTotals.income += childTotals.income;
        parentTotals.expense += childTotals.expense;
        parentTotals.balance += childTotals.balance;
      }
    }
  });

  // 4. Filter for Bilan: Only show Parents and Independent accounts (skip children)
  const bilanAccounts = accounts.filter(acc => !acc.parentId);

  // Prepare rows
  const accountSummaries = bilanAccounts.map(acc => {
    const totals = processedMap.get(acc.id)!;

    return {
      Code: acc.code,
      Account: acc.label,
      Type: acc.type,
      Income: totals.income,
      Expense: totals.expense,
      Balance: totals.balance
    };
  }).filter(a => a.Income !== 0 || a.Expense !== 0); // Optional: Hide zero balance rows? Let's keep them if they exist or filter if wanted.

  // Add Grand Totals
  const totalIncome = accountSummaries.reduce((sum, a) => sum + a.Income, 0);
  const totalExpense = accountSummaries.reduce((sum, a) => sum + a.Expense, 0);
  const netResult = totalIncome + totalExpense;

  // Convert to worksheet data
  const bilanData = [
    ["RAPPORT FINANCIER / FINANCIAL REPORT"],
    ["Généré le", new Date().toLocaleDateString()],
    ["Note: Les sous-comptes sont agrégés dans leurs comptes parents."],
    [""],
    ["CODE", "COMPTE", "TYPE", "RECETTES (INCOME)", "DÉPENSES (EXPENSE)", "BALANCE"],
    ...accountSummaries.map(a => [
      a.Code,
      a.Account,
      a.Type,
      a.Income,
      a.Expense,
      a.Balance
    ]),
    [""],
    ["", "TOTAUX", "", totalIncome, totalExpense, netResult],
    [""],
    ["", "RÉSULTAT NET", "", "", "", netResult]
  ];

  const wsBilan = XLSX.utils.aoa_to_sheet(bilanData);
  XLSX.utils.book_append_sheet(wb, wsBilan, "Bilan (Agrégé)");

  // --- SHEET 2: JOURNAL (Transactions) ---

  const journalData = transactions.map(t => {
    const acc = accounts.find(a => a.id === t.accountId);
    const parent = acc?.parentId ? accounts.find(p => p.id === acc.parentId) : null;

    return {
      Date: t.date,
      Libellé: t.description,
      Montant: t.amount,
      CodeCompte: acc?.code || 'Non Catégorisé',
      NomCompte: acc?.label || '',
      Parent: parent ? `${parent.code} - ${parent.label}` : '-', // Show parent context in journal too
      Membre: t.detectedMemberName || '',
      Statut: t.status
    };
  });

  const wsJournal = XLSX.utils.json_to_sheet(journalData);
  XLSX.utils.book_append_sheet(wb, wsJournal, "Journal (Détail)");

  // --- DOWNLOAD ---
  XLSX.writeFile(wb, "Comptabilite_Asso_Complete.xlsx");
};

/**
 * Parses an existing Excel ledger
 */
export const parseExcelLedger = async (file: File): Promise<Transaction[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        // Get raw JSON
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        // Simple heuristic: Assume headers are in row 0
        // Look for common column names
        const headers = (jsonData[0] as string[]).map(h => h.toLowerCase());

        const dateIdx = headers.findIndex(h => h.includes('date'));
        const descIdx = headers.findIndex(h => h.includes('libell') || h.includes('desc') || h.includes('label'));
        const debitIdx = headers.findIndex(h => h.includes('debit') || h.includes('dépense'));
        const creditIdx = headers.findIndex(h => h.includes('credit') || h.includes('recette'));
        const amountIdx = headers.findIndex(h => h.includes('amount') || h.includes('montant')); // If single column

        if (dateIdx === -1 || descIdx === -1) {
          reject("Impossible de trouver les colonnes 'Date' ou 'Libellé' dans le fichier Excel.");
          return;
        }

        const transactions: Transaction[] = [];

        // Iterate rows (skip header)
        for (let i = 1; i < jsonData.length; i++) {
          const row = jsonData[i] as any[];
          if (!row || row.length === 0) continue;

          let amount = 0;

          // Logic 1: Debit/Credit columns
          if (debitIdx !== -1 && creditIdx !== -1) {
            const debit = parseFloat(row[debitIdx]) || 0;
            const credit = parseFloat(row[creditIdx]) || 0;
            amount = credit - debit; // Credit is positive, Debit is negative
          }
          // Logic 2: Single Amount column
          else if (amountIdx !== -1) {
            amount = parseFloat(row[amountIdx]) || 0;
          }

          if (amount === 0 && !row[descIdx]) continue;

          // Normalize Date (Excel dates can be numbers)
          let dateStr = row[dateIdx];
          if (typeof dateStr === 'number') {
            // Excel serial date to JS Date
            const dateObj = new Date((dateStr - (25567 + 2)) * 86400 * 1000);
            dateStr = dateObj.toISOString().split('T')[0];
          }

          transactions.push({
            id: `excel-${Date.now()}-${i}`,
            date: dateStr,
            description: row[descIdx] || 'Transaction Importée',
            amount: amount,
            status: TransactionStatus.PENDING, // Needs classification
            accountId: undefined // User must classify or we match later
          });
        }

        resolve(transactions);

      } catch (err) {
        reject("Échec de la lecture du fichier Excel.");
      }
    };
    reader.readAsBinaryString(file);
  });
};