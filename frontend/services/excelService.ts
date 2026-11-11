import * as XLSX from 'xlsx';
import { Account, Transaction, AccountType, TransactionStatus } from '../../types';

/**
 * Generates a full accounting report (Bilan + Journal)
 * Aggregates Sub-Accounts into Parent Accounts for the Bilan sheet.
 */
export const generateAccountingReport = (transactions: Transaction[], accounts: Account[]) => {
  const wb = XLSX.utils.book_new();

  // --- SHEET 1: PLAN COMPTABLE COMPLET & BILAN (AVEC SOUS-COMPTES) ---

  // 1. Initialize maps for direct totals (transactions on the account itself)
  //    and consolidated totals (including children & grandchildren)
  const directTotalsMap = new Map<string, { income: number; expense: number; balance: number }>();
  const consolidatedMap = new Map<string, { income: number; expense: number; balance: number }>();

  accounts.forEach(acc => {
    directTotalsMap.set(acc.id, { income: 0, expense: 0, balance: 0 });
  });

  // 2. Sum transactions per DIRECT account
  let uncategorizedIncome = 0;
  let uncategorizedExpense = 0;

  transactions.forEach(t => {
    if (t.accountId && directTotalsMap.has(t.accountId)) {
      const current = directTotalsMap.get(t.accountId)!;
      current.balance += t.amount;
      if (t.amount > 0) current.income += t.amount;
      else current.expense += t.amount;
    } else {
      if (t.amount > 0) uncategorizedIncome += t.amount;
      else uncategorizedExpense += t.amount;
    }
  });

  // Initialize consolidated map with direct totals
  accounts.forEach(acc => {
    const direct = directTotalsMap.get(acc.id)!;
    consolidatedMap.set(acc.id, { ...direct });
  });

  // Helper to check if an account is a root account (no valid parent)
  const isRootAccount = (a: Account): boolean => {
    if (!a.parentId) return true;
    const p = String(a.parentId).trim().toLowerCase();
    if (p === '' || p === 'null' || p === 'undefined') return true;
    return !accounts.some(parent => parent.id === a.parentId);
  };

  // Helper to get account depth level (1 = Root, 2 = Sub-account, 3 = Sub-sub-account)
  const getAccountLevel = (a: Account): number => {
    if (isRootAccount(a)) return 1;
    const parent = accounts.find(p => p.id === a.parentId);
    if (!parent || isRootAccount(parent)) return 2;
    return 3;
  };

  //Helper to build full account path
  const getAccountFullPath = (acc?: Account): string => {
    if (!acc) return 'Non Catégorisé';
    const parts = [acc.label];
    let current: Account | undefined = acc;
    for (let i = 0; i < 3; i++) {
      if (current?.parentId) {
        const parent = accounts.find(p => p.id === current!.parentId);
        if (parent) {
          parts.unshift(parent.label);
          current = parent;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    return parts.join(' > ');
  };

  // 3. Roll up Child totals into Parents (Level 3 -> Level 2 -> Level 1)
  accounts.forEach(acc => {
    if (getAccountLevel(acc) === 3 && acc.parentId) {
      const parentTotals = consolidatedMap.get(acc.parentId);
      const childTotals = directTotalsMap.get(acc.id);
      if (parentTotals && childTotals) {
        parentTotals.income += childTotals.income;
        parentTotals.expense += childTotals.expense;
        parentTotals.balance += childTotals.balance;
      }
    }
  });

  accounts.forEach(acc => {
    if (getAccountLevel(acc) === 2 && acc.parentId) {
      const parentTotals = consolidatedMap.get(acc.parentId);
      const childTotals = consolidatedMap.get(acc.id); // includes rolled-up L3
      if (parentTotals && childTotals) {
        parentTotals.income += childTotals.income;
        parentTotals.expense += childTotals.expense;
        parentTotals.balance += childTotals.balance;
      }
    }
  });

  // 4. Sort ALL accounts hierarchically (Root -> Level 2 -> Level 3)
  const orderedAccounts: Array<{ account: Account; level: number; hasChildren: boolean }> = [];
  const visitedIds = new Set<string>();

  const roots = accounts
    .filter(a => isRootAccount(a))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  roots.forEach(root => {
    const level2 = accounts
      .filter(c => c.parentId === root.id)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

    orderedAccounts.push({ account: root, level: 1, hasChildren: level2.length > 0 });
    visitedIds.add(root.id);

    level2.forEach(child => {
      const level3 = accounts
        .filter(gc => gc.parentId === child.id)
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

      orderedAccounts.push({ account: child, level: 2, hasChildren: level3.length > 0 });
      visitedIds.add(child.id);

      level3.forEach(grandchild => {
        orderedAccounts.push({ account: grandchild, level: 3, hasChildren: false });
        visitedIds.add(grandchild.id);
      });
    });
  });

  // Append any remaining accounts if any
  accounts
    .filter(a => !visitedIds.has(a.id))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .forEach(orphan => {
      orderedAccounts.push({ account: orphan, level: 1, hasChildren: false });
    });

  // 5. Build rows for the full chart of accounts (Parents + Sub-accounts)
  const planRows = orderedAccounts.map(({ account: acc, level, hasChildren }) => {
    const direct = directTotalsMap.get(acc.id) || { income: 0, expense: 0, balance: 0 };
    const consolidated = consolidatedMap.get(acc.id) || { income: 0, expense: 0, balance: 0 };
    const parent = acc.parentId ? accounts.find(p => p.id === acc.parentId) : undefined;

    const indent = level === 2 ? '   ↳ ' : level === 3 ? '      ↳ ' : '';
    const hierarchyLabel =
      level === 1
        ? hasChildren
          ? 'Compte Parent'
          : 'Compte Principal'
        : level === 2
        ? 'Sous-compte'
        : 'Sous-compte (Niv. 3)';

    // For parent accounts with children, show consolidated values in main columns so the summary is visible,
    // and also provide the direct vs consolidated breakdown
    const displayIncome = hasChildren ? consolidated.income : direct.income;
    const displayExpense = hasChildren ? consolidated.expense : direct.expense;
    const displayBalance = hasChildren ? consolidated.balance : direct.balance;

    return [
      acc.code,
      `${indent}${acc.label}`,
      hierarchyLabel,
      parent ? `${parent.code} - ${parent.label}` : '-',
      acc.type,
      Number(displayIncome.toFixed(2)),
      Number(displayExpense.toFixed(2)),
      Number(displayBalance.toFixed(2)),
      acc.initialBalance !== undefined ? Number(acc.initialBalance.toFixed(2)) : 0
    ];
  });

  if (uncategorizedIncome !== 0 || uncategorizedExpense !== 0) {
    planRows.push([
      'N/A',
      'Transactions non catégorisées',
      'Non affecté',
      '-',
      '-',
      Number(uncategorizedIncome.toFixed(2)),
      Number(uncategorizedExpense.toFixed(2)),
      Number((uncategorizedIncome + uncategorizedExpense).toFixed(2)),
      0
    ]);
  }

  // Grand Totals (computed from direct transactions only, to avoid double-counting parents + sub-accounts)
  const totalIncome = Number(
    transactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0).toFixed(2)
  );
  const totalExpense = Number(
    transactions.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0).toFixed(2)
  );
  const netResult = Number((totalIncome + totalExpense).toFixed(2));

  const bilanData = [
    ["RAPPORT FINANCIER & PLAN COMPTABLE COMPLET (AVEC SOUS-COMPTES)"],
    ["Généré le", new Date().toLocaleDateString('fr-CH')],
    ["Note : Les comptes parents affichent le cumul de leurs sous-comptes. La ligne TOTAUX additionne les écritures réelles sans double comptage."],
    [""],
    [
      "CODE",
      "COMPTE / SOUS-COMPTE",
      "NIVEAU",
      "COMPTE PARENT",
      "TYPE",
      "RECETTES (INCOME)",
      "DÉPENSES (EXPENSE)",
      "SOLDE PÉRIODE",
      "SOLDE INITIAL"
    ],
    ...planRows,
    [""],
    ["", "TOTAUX (ÉCRITURES RÉELLES)", "", "", "", totalIncome, totalExpense, netResult, ""],
    [""],
    ["", "RÉSULTAT NET DE L'EXERCICE", "", "", "", "", "", netResult, ""]
  ];

  const wsBilan = XLSX.utils.aoa_to_sheet(bilanData);
  wsBilan['!cols'] = [
    { wch: 12 },
    { wch: 38 },
    { wch: 20 },
    { wch: 28 },
    { wch: 12 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, wsBilan, "Plan Comptable & Bilan");

  // --- SHEET 2: JOURNAL (Transactions) ---

  const journalData = transactions.map(t => {
    const acc = accounts.find(a => a.id === t.accountId);
    const parent = acc?.parentId ? accounts.find(p => p.id === acc.parentId) : null;
    const grandParent = parent?.parentId ? accounts.find(gp => gp.id === parent.parentId) : null;
    const rootParent = grandParent || parent;

    return {
      Date: t.date,
      Libellé: t.description,
      Débit: t.amount < 0 ? Number(Math.abs(t.amount).toFixed(2)) : '',
      Crédit: t.amount > 0 ? Number(t.amount.toFixed(2)) : '',
      Montant: Number(t.amount.toFixed(2)),
      CodeCompte: acc?.code || 'Non Catégorisé',
      SousCompte: acc?.label || 'Non Catégorisé',
      CompteParent: rootParent ? `${rootParent.code} - ${rootParent.label}` : (acc ? `${acc.code} - ${acc.label}` : '-'),
      CheminComplet: getAccountFullPath(acc),
      Membre: t.detectedMemberName || '',
      Statut: t.status,
      Notes: t.notes || ''
    };
  });

  const wsJournal = XLSX.utils.json_to_sheet(journalData);
  wsJournal['!cols'] = [
    { wch: 12 },
    { wch: 42 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 28 },
    { wch: 28 },
    { wch: 40 },
    { wch: 20 },
    { wch: 14 },
    { wch: 30 }
  ];
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