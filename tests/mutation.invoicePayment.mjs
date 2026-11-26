import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const testPath = path.join(REPO_ROOT, 'tests/feat.invoicePayment.test.mjs');

const FILES = {
  matching: 'frontend/services/reimbursementMatching.ts',
  app: 'App.tsx',
  view: 'frontend/components/ReimbursementsView.tsx',
  notif: 'frontend/services/rentalNotificationService.ts',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);

const mutants = [
  {
    id: 'I01',
    fileKey: 'matching',
    description: 'isPayableExpenseType : exclut INVOICE_PAYMENT',
    target: "return expenseType === 'REIMBURSEMENT' || expenseType === 'INVOICE_PAYMENT';",
    replacement: "return expenseType === 'REIMBURSEMENT';",
  },
  {
    id: 'I02',
    fileKey: 'matching',
    description: 'isPayableExpenseType : inclut aussi DEBIT_CARD',
    target: "return expenseType === 'REIMBURSEMENT' || expenseType === 'INVOICE_PAYMENT';",
    replacement: "return expenseType === 'REIMBURSEMENT' || expenseType === 'INVOICE_PAYMENT' || expenseType === 'DEBIT_CARD';",
  },
  {
    id: 'I03',
    fileKey: 'matching',
    description: 'scoreReceiptTransactionMatch : autorise crédit positif pour INVOICE_PAYMENT',
    target: '  if (isExpenseReceipt && transaction.amount > 0) {',
    replacement: '  if (false && isExpenseReceipt && transaction.amount > 0) {',
  },
  {
    id: 'I04',
    fileKey: 'matching',
    description: 'scoreReceiptTransactionMatch : désactive limite 365 jours',
    target: 'if (diffDays < -7 || diffDays > 365) {',
    replacement: 'if (diffDays < -7) {',
  },
  {
    id: 'I05',
    fileKey: 'matching',
    description: 'computeReimbursementStats : ne filtre plus sur isPayableExpenseType',
    target: 'const reimbursements = receipts.filter((r) => isPayableExpenseType(r.expenseType));',
    replacement: 'const reimbursements = receipts;',
  },
  {
    id: 'I06',
    fileKey: 'app',
    description: 'App.tsx : n envoie plus de mail de confirmation pour INVOICE_PAYMENT',
    target: "(updatedReceipt.expenseType === 'REIMBURSEMENT' || updatedReceipt.expenseType === 'INVOICE_PAYMENT') &&",
    replacement: "updatedReceipt.expenseType === 'REIMBURSEMENT' &&",
  },
  {
    id: 'I07',
    fileKey: 'app',
    description: 'App.tsx : n inclut plus INVOICE_PAYMENT dans le compteur badge',
    target: "r => (r.expenseType === 'REIMBURSEMENT' || r.expenseType === 'INVOICE_PAYMENT') && r.reimbursementStatus !== 'REIMBURSED'",
    replacement: "r => r.expenseType === 'REIMBURSEMENT' && r.reimbursementStatus !== 'REIMBURSED'",
  },
  {
    id: 'I08',
    fileKey: 'view',
    description: 'ReimbursementsView : supprime détection INVOICE_PAYMENT',
    target: "const isInvoicePayment = receipt.expenseType === 'INVOICE_PAYMENT';",
    replacement: 'const isInvoicePayment = false;',
  },
  {
    id: 'I09',
    fileKey: 'notif',
    description: 'rentalNotificationService : supprime branche INVOICE_PAYMENT dans mail de confirmation',
    target: "const isInvoicePayment = receipt.expenseType === 'INVOICE_PAYMENT';",
    replacement: 'const isInvoicePayment = false;',
  },
  {
    id: 'I10',
    fileKey: 'notif',
    description: 'rentalNotificationService : oublie le type audit INVOICE_PAYMENT_DONE_MEMBER_NOTIFIED',
    target: "type: isInvoicePayment ? 'INVOICE_PAYMENT_DONE_MEMBER_NOTIFIED' : 'REIMBURSEMENT_DONE_MEMBER_NOTIFIED',",
    replacement: "type: 'REIMBURSEMENT_DONE_MEMBER_NOTIFIED',",
  },
];

let killed = 0;
let invalid = 0;
const survivors = [];

try {
  for (const m of mutants) {
    const absPath = path.join(REPO_ROOT, FILES[m.fileKey]);
    const orig = originals[m.fileKey];
    const normalized = orig.replace(/\r\n/g, '\n');
    if (!normalized.includes(m.target)) {
      console.error(`[INVALID] ${m.id} (${m.description}): target not matched in ${FILES[m.fileKey]}`);
      invalid += 1;
      continue;
    }
    const mutated = normalized.replace(m.target, m.replacement);
    fs.writeFileSync(absPath, mutated, 'utf8');
    const res = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--test', testPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
      }
    );
    fs.writeFileSync(absPath, orig, 'utf8');

    if (res.status !== 0) {
      killed += 1;
      console.log(`[KILLED] ${m.id}: ${m.description}`);
    } else {
      survivors.push(m.id);
      console.error(`[SURVIVED] ${m.id}: ${m.description}`);
    }
  }
} finally {
  for (const [k, content] of Object.entries(originals)) {
    fs.writeFileSync(path.join(REPO_ROOT, FILES[k]), content, 'utf8');
  }
}

console.log(`\nWeb INVOICE_PAYMENT Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
