import type { Receipt, Transaction } from '../../types';

export interface SubmitterIdentity {
  firstName: string;
  lastName: string;
  email: string;
  displayFullName: string;
}

export interface ReimbursementStats {
  pendingCount: number;
  pendingTotalChf: number;
  reimbursedCount: number;
  reimbursedTotalChf: number;
  totalCount: number;
}

function normalizeText(value?: string | null): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function capitalizeWord(word: string): string {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Extrait clairement le Prénom, le Nom et l'E-mail de la personne à rembourser
 * à partir de `submittedByName` et `submittedByEmail`.
 */
export function splitSubmitterIdentity(
  fullName?: string | null,
  email?: string | null
): SubmitterIdentity {
  const cleanName = (fullName || '').trim().replace(/\s+/g, ' ');
  const cleanEmail = (email || '').trim();

  if (cleanName.length > 0) {
    const parts = cleanName.split(' ');
    if (parts.length === 1) {
      return {
        firstName: parts[0],
        lastName: '-',
        email: cleanEmail || '-',
        displayFullName: parts[0],
      };
    }
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    return {
      firstName,
      lastName,
      email: cleanEmail || '-',
      displayFullName: cleanName,
    };
  }

  if (cleanEmail.includes('@')) {
    const localPart = cleanEmail.split('@')[0];
    const tokens = localPart.split(/[._-]+/).filter(Boolean);
    if (tokens.length >= 2) {
      const firstName = capitalizeWord(tokens[0]);
      const lastName = tokens.slice(1).map(capitalizeWord).join(' ');
      return {
        firstName,
        lastName,
        email: cleanEmail,
        displayFullName: `${firstName} ${lastName}`,
      };
    }
    if (tokens.length === 1) {
      const firstName = capitalizeWord(tokens[0]);
      return {
        firstName,
        lastName: '-',
        email: cleanEmail,
        displayFullName: firstName,
      };
    }
  }

  return {
    firstName: '-',
    lastName: '-',
    email: cleanEmail || '-',
    displayFullName: 'Membre non renseigné',
  };
}

/**
 * Calcule un score de rapprochement entre un justificatif et une écriture bancaire :
 * - Pour `DEBIT_CARD` (Carte de débit/crédit) : la transaction bancaire a lieu le jour même (J)
 *   ou le jour suivant (J+1), avec une légère tolérance bancaire (-1 à +4 jours). Au-delà, rejeté.
 * - Pour `REIMBURSEMENT` (À rembourser) : la date du justificatif n'est PAS la date du virement
 *   de remboursement. Aucun malus de délai tant que le remboursement n'est pas antérieur de plus de 7 jours,
 *   et bonus fort si le nom/prénom/email du membre ou le mot "remboursement" apparaît dans le libellé.
 */
export function scoreReceiptTransactionMatch(
  receipt: Receipt,
  transaction: Transaction
): number {
  if (transaction.receiptUrl) return -1;
  if (receipt.extractedAmount === null || receipt.extractedAmount === undefined) return -1;

  const isExpenseReceipt =
    receipt.expenseType === 'DEBIT_CARD' || receipt.expenseType === 'REIMBURSEMENT';

  if (isExpenseReceipt && transaction.amount > 0) {
    return -1;
  }

  const amountDiff = Math.abs(Math.abs(transaction.amount) - Math.abs(receipt.extractedAmount));
  if (amountDiff >= 0.1) {
    return -1;
  }

  let score = 10;

  let diffDays: number | null = null;
  if (receipt.extractedDate && transaction.date) {
    const rTime = new Date(receipt.extractedDate).getTime();
    const tTime = new Date(transaction.date).getTime();
    if (!Number.isNaN(rTime) && !Number.isNaN(tTime)) {
      diffDays = Math.round((tTime - rTime) / (1000 * 3600 * 24));
    }
  }

  const haystack = normalizeText(
    [
      transaction.description,
      transaction.simplifiedDescription,
      transaction.fullRawText,
      transaction.detectedMemberName,
      transaction.notes,
    ]
      .filter(Boolean)
      .join(' ')
  );

  if (receipt.expenseType === 'DEBIT_CARD') {
    if (diffDays !== null) {
      if (diffDays === 0 || diffDays === 1) {
        // Jour même (J) ou jour suivant (J+1)
        score += 20;
      } else if (diffDays >= -1 && diffDays <= 4) {
        // Tolérance week-end / compensation bancaire
        score += 8;
      } else {
        // Hors délai pour une carte de débit/crédit
        return -1;
      }
    }
  } else if (receipt.expenseType === 'REIMBURSEMENT') {
    if (diffDays !== null) {
      if (diffDays < -7 || diffDays > 365) {
        return -1;
      }
      // La date du justificatif n'est pas la date du virement de remboursement : pas de pénalité !
      score += 6;
    }

    const identity = splitSubmitterIdentity(receipt.submittedByName, receipt.submittedByEmail);
    const normLast = normalizeText(identity.lastName);
    const normFirst = normalizeText(identity.firstName);

    if (normLast && normLast !== '-' && normLast.length >= 2 && haystack.includes(normLast)) {
      score += 12;
    }
    if (normFirst && normFirst !== '-' && normFirst.length >= 2 && haystack.includes(normFirst)) {
      score += 8;
    }
    if (receipt.submittedByEmail && receipt.submittedByEmail.includes('@')) {
      const emailPrefix = normalizeText(receipt.submittedByEmail.split('@')[0]);
      if (emailPrefix.length >= 3 && haystack.includes(emailPrefix)) {
        score += 8;
      }
    }
    if (
      haystack.includes('remboursement') ||
      haystack.includes('remb ') ||
      haystack.includes('remb.') ||
      haystack.includes('note de frais')
    ) {
      score += 6;
    }
  } else {
    // Comportement standard (justificatif sans type explicite)
    if (diffDays !== null) {
      if (diffDays === 0 || diffDays === 1) {
        score += 12;
      } else if (diffDays >= -1 && diffDays <= 45) {
        score += 5;
      } else if (diffDays < -5) {
        return -1;
      }
    }
  }

  // Bonus mots-clés (fournisseur, motif, nom de fichier)
  const keywordSources = [
    receipt.merchantName || '',
    receipt.description || '',
    receipt.comment || '',
    (receipt.fileName || '').replace(/\.[^/.]+$/, ''),
  ].join(' ');

  const words = normalizeText(keywordSources)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !['scan', 'img', 'pdf', 'facture', 'recu', 'ticket'].includes(w));

  if (words.some((w) => haystack.includes(w))) {
    score += 4;
  }

  return score;
}

/**
 * Retourne les transactions bancaires candidates triées par pertinence.
 */
export function findPotentialMatchesForReceipt(
  receipt: Receipt,
  transactions: Transaction[]
): Transaction[] {
  if (receipt.extractedAmount === null || receipt.extractedAmount === undefined) {
    return [];
  }

  const scored = transactions
    .map((t) => ({
      transaction: t,
      score: scoreReceiptTransactionMatch(receipt, t),
    }))
    .filter((item) => item.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.transaction);
}

/**
 * Permet de biffer (marquer comme remboursé) ou débiffer une demande de remboursement.
 */
export function toggleReceiptReimbursed(
  receipt: Receipt,
  actor: { uid: string; name: string },
  nowMs?: number
): Receipt {
  if (receipt.reimbursementStatus === 'REIMBURSED') {
    return {
      ...receipt,
      reimbursementStatus: 'PENDING',
      reimbursedAt: undefined,
      reimbursedByUid: undefined,
      reimbursedByName: undefined,
    };
  }

  return {
    ...receipt,
    reimbursementStatus: 'REIMBURSED',
    reimbursedAt: nowMs ?? Date.now(),
    reimbursedByUid: actor.uid,
    reimbursedByName: actor.name,
  };
}

/**
 * Filtre et trie les justificatifs "À rembourser" (`expenseType === 'REIMBURSEMENT'`).
 */
export function filterReimbursementReceipts(
  receipts: Receipt[],
  statusFilter: 'PENDING' | 'REIMBURSED' | 'ALL' = 'ALL',
  searchQuery: string = ''
): Receipt[] {
  const query = normalizeText(searchQuery);

  return receipts
    .filter((r) => r.expenseType === 'REIMBURSEMENT')
    .filter((r) => {
      const isReimbursed = r.reimbursementStatus === 'REIMBURSED';
      if (statusFilter === 'PENDING') return !isReimbursed;
      if (statusFilter === 'REIMBURSED') return isReimbursed;
      return true;
    })
    .filter((r) => {
      if (!query) return true;
      const identity = splitSubmitterIdentity(r.submittedByName, r.submittedByEmail);
      const searchable = normalizeText(
        [
          identity.firstName,
          identity.lastName,
          identity.email,
          r.submittedByName,
          r.submittedByEmail,
          r.merchantName,
          r.description,
          r.comment,
          r.reimbursementIban,
          r.fileName,
          r.extractedAmount !== null && r.extractedAmount !== undefined
            ? r.extractedAmount.toFixed(2)
            : '',
        ]
          .filter(Boolean)
          .join(' ')
      );
      return searchable.includes(query);
    })
    .sort((a, b) => {
      const aDone = a.reimbursementStatus === 'REIMBURSED' ? 1 : 0;
      const bDone = b.reimbursementStatus === 'REIMBURSED' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const dateA = a.extractedDate || a.uploadDate || '';
      const dateB = b.extractedDate || b.uploadDate || '';
      return dateB.localeCompare(dateA);
    });
}

/**
 * Calcule les totaux de remboursements (en attente vs biffés/remboursés).
 */
export function computeReimbursementStats(receipts: Receipt[]): ReimbursementStats {
  const reimbursements = receipts.filter((r) => r.expenseType === 'REIMBURSEMENT');
  let pendingCount = 0;
  let pendingTotalChf = 0;
  let reimbursedCount = 0;
  let reimbursedTotalChf = 0;

  for (const r of reimbursements) {
    const amount = Math.abs(r.extractedAmount || 0);
    if (r.reimbursementStatus === 'REIMBURSED') {
      reimbursedCount += 1;
      reimbursedTotalChf += amount;
    } else {
      pendingCount += 1;
      pendingTotalChf += amount;
    }
  }

  return {
    pendingCount,
    pendingTotalChf: Math.round(pendingTotalChf * 100) / 100,
    reimbursedCount,
    reimbursedTotalChf: Math.round(reimbursedTotalChf * 100) / 100,
    totalCount: reimbursements.length,
  };
}

/**
 * Rapproche automatiquement un lot de transactions bancaires avec les justificatifs non liés :
 * - Pour `DEBIT_CARD` : exige un montant identique et une date J ou J+1 (ou tolérance bancaire -1..+4j).
 * - Pour `REIMBURSEMENT` : ignore l'écart entre la date du justificatif et la date du virement,
 *   et privilégie la correspondance sur le montant + nom/prénom/email du membre ou libellé remboursement.
 */
export function matchTransactionsWithReceipts(
  transactions: Transaction[],
  receipts: Receipt[]
): { processedTxns: Transaction[]; matchedReceiptIds: string[] } {
  const matchedIds: string[] = [];
  const unlinkedReceipts = receipts.filter((r) => !r.linkedTransactionId);
  const processedTxns = [...transactions];

  const updatedTxns = processedTxns.map((txn) => {
    if (txn.receiptUrl) return txn;

    let bestReceipt: Receipt | null = null;
    let bestScore = 0;

    for (const r of unlinkedReceipts) {
      if (matchedIds.includes(r.id)) continue;
      const score = scoreReceiptTransactionMatch(r, txn);
      // Seuil minimum de confiance pour l'auto-match :
      // - Carte de débit J / J+1 (score >= 30) ou -1..+4j (score >= 18)
      // - Remboursement (montant exact + date valide >= 16, bonifié par nom/prénom/libellé)
      // - Legacy (montant + date <= 7j ou mot-clé >= 15)
      if (score >= 15 && score > bestScore) {
        bestScore = score;
        bestReceipt = r;
      }
    }

    if (bestReceipt) {
      matchedIds.push(bestReceipt.id);
      const nameWithoutExt = bestReceipt.fileName
        ? bestReceipt.fileName.replace(/\.[^/.]+$/, '')
        : undefined;
      return {
        ...txn,
        receiptUrl: bestReceipt.url,
        receiptFileName: nameWithoutExt,
      };
    }

    return txn;
  });

  return { processedTxns: updatedTxns, matchedReceiptIds: matchedIds };
}

