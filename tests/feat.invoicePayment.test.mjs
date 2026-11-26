import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPayableExpenseType,
  scoreReceiptTransactionMatch,
  filterReimbursementReceipts,
  computeReimbursementStats,
  toggleReceiptReimbursed,
} from '../frontend/services/reimbursementMatching.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('[INVOICE_PAYMENT][Positive] includes INVOICE_PAYMENT in payable tab, stats, matching, and toggle without IBAN', () => {
  assert.equal(isPayableExpenseType('INVOICE_PAYMENT'), true);
  assert.equal(isPayableExpenseType('REIMBURSEMENT'), true);

  const receipts = [
    {
      id: 'r-card',
      url: 'https://firebasestorage.googleapis.com/v0/b/x/o/c.jpg',
      fileName: 'card.jpg',
      uploadDate: '2026-03-01',
      extractedDate: '2026-03-01',
      extractedAmount: 20,
      isAnalyzed: true,
      expenseType: 'DEBIT_CARD',
    },
    {
      id: 'r-remb',
      url: 'https://firebasestorage.googleapis.com/v0/b/x/o/r.jpg',
      fileName: 'remb.jpg',
      uploadDate: '2026-03-02',
      extractedDate: '2026-03-02',
      extractedAmount: 50,
      isAnalyzed: true,
      expenseType: 'REIMBURSEMENT',
      reimbursementStatus: 'PENDING',
      reimbursementIban: 'CH93 0076 2011 6238 5295 7',
      submittedByName: 'Alice Martin',
    },
    {
      id: 'r-inv',
      url: 'https://firebasestorage.googleapis.com/v0/b/x/o/inv.pdf',
      fileName: 'facture_fournisseur.pdf',
      uploadDate: '2026-03-05',
      extractedDate: '2026-03-05',
      extractedAmount: 185.5,
      isAnalyzed: true,
      expenseType: 'INVOICE_PAYMENT',
      reimbursementStatus: 'PENDING',
      merchantName: 'Imprimerie Romande SA',
      description: 'Flyers camp été',
      submittedByName: 'Bob Durand',
      submittedByEmail: 'bob@asso.ch',
    },
  ];

  const filtered = filterReimbursementReceipts(receipts, 'PENDING', '');
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].id, 'r-inv');
  assert.equal(filtered[1].id, 'r-remb');

  const stats = computeReimbursementStats(receipts);
  assert.equal(stats.totalCount, 2);
  assert.equal(stats.pendingCount, 2);
  assert.equal(stats.pendingTotalChf, 235.5);
  assert.equal(stats.reimbursedCount, 0);

  // Invoice payment matches bank debit even 20 days later
  const txn = {
    id: 't-1',
    date: '2026-03-25',
    description: 'VIRT Imprimerie Romande SA',
    amount: -185.5,
    status: 'PENDING',
  };
  assert.ok(scoreReceiptTransactionMatch(receipts[2], txn) >= 16);

  // Toggle marks invoice as REIMBURSED (paid) without requiring IBAN
  const paid = toggleReceiptReimbursed(receipts[2], { uid: 'c1', name: 'Caissier' }, 1710000000000);
  assert.equal(paid.reimbursementStatus, 'REIMBURSED');
  assert.equal(paid.reimbursedByName, 'Caissier');
});

test('[INVOICE_PAYMENT][Negative & Boundary] excludes DEBIT_CARD/unknown, rejects credit txns and >365d lag', () => {
  assert.equal(isPayableExpenseType('DEBIT_CARD'), false);
  assert.equal(isPayableExpenseType(''), false);
  assert.equal(isPayableExpenseType(null), false);

  const invoice = {
    id: 'r-inv-2',
    url: 'https://firebasestorage.googleapis.com/v0/b/x/o/inv2.pdf',
    fileName: 'inv2.pdf',
    uploadDate: '2026-01-01',
    extractedDate: '2026-01-01',
    extractedAmount: 100,
    isAnalyzed: true,
    expenseType: 'INVOICE_PAYMENT',
    reimbursementStatus: 'PENDING',
  };

  // Positive credit transaction must not match an INVOICE_PAYMENT expense
  assert.equal(
    scoreReceiptTransactionMatch(invoice, {
      id: 't-credit',
      date: '2026-01-10',
      description: 'Entrée',
      amount: 100,
      status: 'PENDING',
    }),
    -1
  );

  // Too old (> 365 days) rejected
  assert.equal(
    scoreReceiptTransactionMatch(invoice, {
      id: 't-old',
      date: '2027-02-01',
      description: 'Facture',
      amount: -100,
      status: 'PENDING',
    }),
    -1
  );
});

test('[INVOICE_PAYMENT][Integration] Web UI, App, and notification service support INVOICE_PAYMENT cleanly', () => {
  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'App.tsx'), 'utf8');
  assert.match(appSrc, /updatedReceipt\.expenseType === 'INVOICE_PAYMENT'/);
  assert.match(appSrc, /r\.expenseType === 'INVOICE_PAYMENT'/);

  const viewSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/components/ReimbursementsView.tsx'), 'utf8');
  assert.match(viewSrc, /receipt\.expenseType === 'INVOICE_PAYMENT'/);
  assert.match(viewSrc, /Facture à payer/);
  assert.match(viewSrc, /Paiement sur facture/);

  const notifSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/services/rentalNotificationService.ts'), 'utf8');
  assert.match(notifSrc, /const isInvoicePayment = receipt\.expenseType === 'INVOICE_PAYMENT';/);
  assert.match(notifSrc, /Votre facture a été payée/);
  assert.match(notifSrc, /INVOICE_PAYMENT_DONE_MEMBER_NOTIFIED/);
});
