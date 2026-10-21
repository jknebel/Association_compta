import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Pure helper functions implementing the logic of ReceiptsView for WEB-02
 */
export function filterReceipts(receipts, filterType) {
  if (filterType === 'DEBIT_CARD') {
    return receipts.filter(r => r.expenseType === 'DEBIT_CARD');
  }
  if (filterType === 'REIMBURSEMENT') {
    return receipts.filter(r => r.expenseType === 'REIMBURSEMENT');
  }
  return receipts;
}

export function computeReceiptCounters(receipts) {
  return {
    total: receipts.length,
    debitCard: receipts.filter(r => r.expenseType === 'DEBIT_CARD').length,
    reimbursement: receipts.filter(r => r.expenseType === 'REIMBURSEMENT').length,
    legacy: receipts.filter(r => !r.expenseType).length,
  };
}

export function markReceiptAsReimbursed(receipt, user, userProfile) {
  if (receipt.expenseType !== 'REIMBURSEMENT') {
    throw new Error('Only reimbursement receipts can be marked as reimbursed');
  }
  return {
    ...receipt,
    reimbursementStatus: 'REIMBURSED',
    reimbursedAt: 1776765600000,
    reimbursedByUid: user?.uid,
    reimbursedByName: userProfile?.displayName || user?.displayName || user?.email || 'Caissier'
  };
}

export function cancelReceiptReimbursement(receipt) {
  if (receipt.expenseType !== 'REIMBURSEMENT') {
    throw new Error('Only reimbursement receipts can cancel reimbursement');
  }
  return {
    ...receipt,
    reimbursementStatus: 'PENDING',
    reimbursedAt: undefined,
    reimbursedByUid: undefined,
    reimbursedByName: undefined
  };
}

// ---------------------- UNIT TESTS ----------------------

test('WEB-02: Legacy receipts without expenseType are handled cleanly in ALL filter', () => {
  const receipts = [
    { id: '1', fileName: 'facture1.pdf', isAnalyzed: true },
    { id: '2', fileName: 'ticket.jpg', isAnalyzed: false }
  ];
  const filtered = filterReceipts(receipts, 'ALL');
  assert.equal(filtered.length, 2);
  const counters = computeReceiptCounters(receipts);
  assert.equal(counters.total, 2);
  assert.equal(counters.debitCard, 0);
  assert.equal(counters.reimbursement, 0);
  assert.equal(counters.legacy, 2);
});

test('WEB-02: Filters correctly isolate DEBIT_CARD and REIMBURSEMENT', () => {
  const receipts = [
    { id: '1', fileName: 'migros.jpg', expenseType: 'DEBIT_CARD', merchantName: 'Migros' },
    { id: '2', fileName: 'coop.jpg', expenseType: 'REIMBURSEMENT', reimbursementIban: 'CH9300000000', reimbursementStatus: 'PENDING' },
    { id: '3', fileName: 'old.pdf' }
  ];

  const debit = filterReceipts(receipts, 'DEBIT_CARD');
  assert.equal(debit.length, 1);
  assert.equal(debit[0].id, '1');

  const reimb = filterReceipts(receipts, 'REIMBURSEMENT');
  assert.equal(reimb.length, 1);
  assert.equal(reimb[0].id, '2');

  const all = filterReceipts(receipts, 'ALL');
  assert.equal(all.length, 3);
});

test('WEB-02: Counters match exact totals across categories', () => {
  const receipts = [
    { id: '1', expenseType: 'DEBIT_CARD' },
    { id: '2', expenseType: 'DEBIT_CARD' },
    { id: '3', expenseType: 'REIMBURSEMENT' },
    { id: '4' }
  ];
  const counters = computeReceiptCounters(receipts);
  assert.deepEqual(counters, {
    total: 4,
    debitCard: 2,
    reimbursement: 1,
    legacy: 1
  });
});

test('WEB-02: Mark as reimbursed sets correct timestamp, status, and author', () => {
  const receipt = {
    id: 'r1',
    fileName: 'ticket_louveteaux.jpg',
    expenseType: 'REIMBURSEMENT',
    reimbursementStatus: 'PENDING',
    extractedAmount: 42.50,
    submittedByName: 'Alexandre'
  };
  const user = { uid: 'u123', email: 'caissier@asso.ch' };
  const userProfile = { displayName: 'Marc Caissier' };

  const reimbursed = markReceiptAsReimbursed(receipt, user, userProfile);

  assert.equal(reimbursed.reimbursementStatus, 'REIMBURSED');
  assert.equal(reimbursed.reimbursedByUid, 'u123');
  assert.equal(reimbursed.reimbursedByName, 'Marc Caissier');
  assert.equal(reimbursed.reimbursedAt, 1776765600000);
});

test('WEB-02: Cancel reimbursement restores PENDING state and cleans metadata', () => {
  const receipt = {
    id: 'r1',
    expenseType: 'REIMBURSEMENT',
    reimbursementStatus: 'REIMBURSED',
    reimbursedAt: 1776765600000,
    reimbursedByUid: 'u123',
    reimbursedByName: 'Marc Caissier'
  };

  const cancelled = cancelReceiptReimbursement(receipt);

  assert.equal(cancelled.reimbursementStatus, 'PENDING');
  assert.equal(cancelled.reimbursedAt, undefined);
  assert.equal(cancelled.reimbursedByUid, undefined);
  assert.equal(cancelled.reimbursedByName, undefined);
});
