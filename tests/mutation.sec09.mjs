import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const testPath = path.resolve(import.meta.dirname, 'sec09.urlHtml.test.mjs');

const FILES = {
  sanitizer: 'frontend/services/urlAndHtmlSanitizer.ts',
  notif: 'frontend/services/rentalNotificationService.ts',
  audit: 'frontend/components/AuditModal.tsx',
  reimb: 'frontend/components/ReimbursementsView.tsx',
  receipts: 'frontend/components/ReceiptsView.tsx',
  ledger: 'frontend/components/LedgerView.tsx',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);

const mutants = [
  {
    id: 'U01',
    fileKey: 'sanitizer',
    description: 'escapeHtml : suppression échappement <',
    target: ".replace(/</g, '&lt;')",
    replacement: '',
  },
  {
    id: 'U02',
    fileKey: 'sanitizer',
    description: 'escapeHtml : suppression échappement &',
    target: ".replace(/&/g, '&amp;')",
    replacement: '',
  },
  {
    id: 'U03',
    fileKey: 'sanitizer',
    description: 'isSafeReceiptUrl : autoriser http://',
    target: "if (parsed.protocol !== 'https:') return false;",
    replacement: "if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;",
  },
  {
    id: 'U04',
    fileKey: 'sanitizer',
    description: 'isSafeReceiptUrl : autoriser credentials embedded user:pass@',
    target: "if (parsed.username !== '' || parsed.password !== '') return false;",
    replacement: "if (false && (parsed.username !== '' || parsed.password !== '')) return false;",
  },
  {
    id: 'U05',
    fileKey: 'sanitizer',
    description: 'isSafeReceiptUrl : limite longueur augmentée à 4096',
    target: 'export const MAX_RECEIPT_URL_LENGTH = 2048;',
    replacement: 'export const MAX_RECEIPT_URL_LENGTH = 4096;',
  },
  {
    id: 'U06',
    fileKey: 'sanitizer',
    description: 'isSafeReceiptUrl : autoriser sous-domaines multi-niveaux sur firebasestorage.app',
    target: 'const FIREBASE_STORAGE_HOST_REGEX = /^[a-z0-9-]+\\.firebasestorage\\.app$/i;',
    replacement: 'const FIREBASE_STORAGE_HOST_REGEX = /\\.firebasestorage\\.app$/i;',
  },
  {
    id: 'U07',
    fileKey: 'notif',
    description: 'rentalNotificationService : retrait escapeHtml sur caissierName',
    target: '${escapeHtml(caissierName)}',
    replacement: '${caissierName}',
  },
  {
    id: 'U08',
    fileKey: 'audit',
    description: 'AuditModal : retrait attribut sandbox sur iframe',
    target: 'sandbox="allow-same-origin" ',
    replacement: '',
  },
  {
    id: 'U09',
    fileKey: 'reimb',
    description: 'ReimbursementsView : bypass sanitizeReceiptUrl',
    target: 'const safeSelectedUrl = sanitizeReceiptUrl(selectedReceipt.url);',
    replacement: 'const safeSelectedUrl = selectedReceipt.url;',
  },
  {
    id: 'U10',
    fileKey: 'ledger',
    description: 'LedgerView : retrait noopener,noreferrer sur window.open',
    target: "window.open(safeUrl, '_blank', 'noopener,noreferrer');",
    replacement: "window.open(safeUrl, '_blank');",
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

console.log(`\nSEC-09 Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
