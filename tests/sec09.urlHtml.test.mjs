import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  escapeHtml,
  isSafeReceiptUrl,
  sanitizeReceiptUrl,
  MAX_RECEIPT_URL_LENGTH,
} from '../frontend/services/urlAndHtmlSanitizer.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

test('[SEC-09][Positive] escapeHtml escapes &, <, >, ", and single quotes cleanly', () => {
  assert.equal(escapeHtml('AssoCompta TDGL 2026'), 'AssoCompta TDGL 2026');
  assert.equal(
    escapeHtml('<script>alert("xss" & \'test\')</script>'),
    '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;test&#39;)&lt;/script&gt;'
  );
});

test('[SEC-09][Positive] isSafeReceiptUrl & sanitizeReceiptUrl allow Firebase Storage HTTPS URLs', () => {
  const urls = [
    'https://firebasestorage.googleapis.com/v0/b/compta-ai.appspot.com/o/receipts%2Fticket.pdf?alt=media',
    'https://storage.googleapis.com/compta-ai.appspot.com/ticket.jpg',
    'https://compta-ai.firebasestorage.app/o/r1.png',
    '  https://firebasestorage.googleapis.com/v0/b/x/o/y.png  ',
  ];
  for (const url of urls) {
    assert.equal(isSafeReceiptUrl(url), true, `Expected safe: ${url}`);
    assert.equal(sanitizeReceiptUrl(url), url.trim());
  }
});

test('[SEC-09][Negative] blocks javascript:, data:, http:, credentials, external domains, and multi-level subdomains', () => {
  const badUrls = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '/relative/receipt.pdf',
    'http://firebasestorage.googleapis.com/v0/b/x/o/y.jpg',
    'https://evil.com/firebasestorage.googleapis.com/x.jpg',
    'https://firebasestorage.googleapis.com.evil.com/x.jpg',
    'https://user:pass@firebasestorage.googleapis.com/x.jpg',
    'https://user@storage.googleapis.com/x.jpg',
    'https://sub.bucket.firebasestorage.app/o/x.jpg',
    '',
    '   ',
    null,
    undefined,
    123,
    {},
  ];
  for (const url of badUrls) {
    assert.equal(isSafeReceiptUrl(url), false, `Expected blocked: ${String(url)}`);
    assert.equal(sanitizeReceiptUrl(url), null);
  }
});

test('[SEC-09][Boundary] URL length 2048 vs 2049 and escapeHtml non-string inputs', () => {
  assert.equal(MAX_RECEIPT_URL_LENGTH, 2048);
  const prefix = 'https://firebasestorage.googleapis.com/';
  const exact2048 = prefix + 'a'.repeat(2048 - prefix.length);
  const over2049 = exact2048 + 'b';

  assert.equal(exact2048.length, 2048);
  assert.equal(over2049.length, 2049);
  assert.equal(isSafeReceiptUrl(exact2048), true);
  assert.equal(isSafeReceiptUrl(over2049), false);

  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('[SEC-09][Integration] rentalNotificationService escapes all HTML email template interpolations', () => {
  const src = readRepoFile('frontend/services/rentalNotificationService.ts');
  assert.match(src, /import\s*\{\s*escapeHtml\s*\}\s*from\s*'\.\/urlAndHtmlSanitizer'/);

  // Extract every HTML string template (rowsHtml + htmlBody) and verify no unescaped dynamic strings remain
  const blocks = src.match(/(?:const\s+htmlBody\s*=\s*`|return\s*`\s*<tr)[\s\S]*?\n\s*`;/g) || [];
  assert.equal(blocks.length, 5, `Expected 5 HTML template blocks (4 htmlBody + rowsHtml), found ${blocks.length}`);

  const dangerousVars = [
    '${rental.createdByName',
    '${rental.renterName',
    '${rental.roomName',
    '${rental.startDate',
    '${rental.endDate',
    '${caissierName}',
    '${r.renterName}',
    '${r.roomName}',
    '${r.startDate}',
    '${r.createdByName',
    '${dateStr}',
    '${member}',
    '${email}',
    '${motif}',
    '${iban}',
    '${amt}',
    '${comptaName}',
    '${memberName',
    '${ibanStr}',
  ];
  for (const block of blocks) {
    for (const v of dangerousVars) {
      assert.equal(block.includes(v), false, `Unescaped variable ${v} found inside HTML email block`);
    }
  }
  assert.match(src, /\$\{escapeHtml\(caissierName\)\}/);
  assert.match(src, /\$\{escapeHtml\(comptaName\)\}/);
  assert.match(src, /\$\{escapeHtml\(ibanStr\)\}/);
});

test('[SEC-09][Integration] UI receipt viewers sanitize URLs and harden iframe/img/window.open', () => {
  const auditModal = readRepoFile('frontend/components/AuditModal.tsx');
  assert.match(auditModal, /sanitizeReceiptUrl\(t\.receiptUrl\)/);
  assert.match(auditModal, /<iframe[^>]*sandbox="allow-same-origin"/);
  assert.match(auditModal, /<iframe[^>]*referrerPolicy="no-referrer"/);
  assert.match(auditModal, /<img[^>]*referrerPolicy="no-referrer"/);

  const reimb = readRepoFile('frontend/components/ReimbursementsView.tsx');
  assert.match(reimb, /sanitizeReceiptUrl\(selectedReceipt\.url\)/);
  assert.match(reimb, /sandbox="allow-same-origin"/);
  assert.match(reimb, /referrerPolicy="no-referrer"/);

  const receipts = readRepoFile('frontend/components/ReceiptsView.tsx');
  assert.match(receipts, /sanitizeReceiptUrl\(url\)/);
  assert.match(receipts, /sanitizeReceiptUrl\(receipt\.url\)/);
  assert.match(receipts, /window\.open\([^)]*'noopener,noreferrer'/);
  assert.match(receipts, /<img[^>]*referrerPolicy="no-referrer"/);

  const ledger = readRepoFile('frontend/components/LedgerView.tsx');
  assert.match(ledger, /sanitizeReceiptUrl\(url\)/);
  assert.match(ledger, /window\.open\([^)]*'noopener,noreferrer'/);
});
