import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function loadFirebaseHeaders() {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'firebase.json'), 'utf8'));
  const block = (cfg.hosting?.headers || []).find((h) => h.source === '**');
  assert.ok(block && Array.isArray(block.headers), 'hosting.headers for "**" must exist');
  const map = new Map();
  for (const h of block.headers) {
    map.set(h.key.toLowerCase(), h.value);
  }
  return map;
}

function parseCspDirectives(csp) {
  const directives = new Map();
  for (const part of String(csp || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    directives.set(name.toLowerCase(), values);
  }
  return directives;
}

test('[SEC-13][Negative] Web index.html removes importmap and external CDN ES module registries', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /type=["']importmap["']/i);
  assert.doesNotMatch(html, /aistudiocdn\.com|esm\.sh/i);
  assert.match(html, /<script\s+type="module"\s+src="\/index\.tsx"><\/script>/);
});

test('[SEC-13][Positive & Boundary] firebase.json enforces all required security headers cleanly', () => {
  const headers = loadFirebaseHeaders();

  const hsts = headers.get('strict-transport-security') || '';
  const maxAgeMatch = hsts.match(/max-age=(\d+)/);
  assert.ok(maxAgeMatch && Number(maxAgeMatch[1]) >= 31536000, 'HSTS max-age must be >= 1 year');
  assert.match(hsts, /includeSubDomains/i);

  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=()');

  // Ensure popup Google Auth is not broken by COOP: same-origin
  const coop = (headers.get('cross-origin-opener-policy') || '').toLowerCase();
  assert.notEqual(coop, 'same-origin');
});

test('[SEC-13][Positive & Negative] CSP restricts script/object/frame surfaces while allowing Firebase & Google Auth', () => {
  const headers = loadFirebaseHeaders();
  const csp = headers.get('content-security-policy');
  assert.ok(csp, 'Content-Security-Policy header must be configured');

  const d = parseCspDirectives(csp);
  assert.deepEqual(d.get('default-src'), ["'self'"]);
  assert.deepEqual(d.get('object-src'), ["'none'"]);
  assert.deepEqual(d.get('base-uri'), ["'self'"]);
  assert.deepEqual(d.get('form-action'), ["'self'"]);
  assert.deepEqual(d.get('frame-ancestors'), ["'none'"]);

  const scriptSrc = d.get('script-src') || [];
  assert.ok(scriptSrc.includes("'self'"));
  assert.ok(scriptSrc.includes('https://apis.google.com'));
  assert.ok(!scriptSrc.includes("'unsafe-inline'"));
  assert.ok(!scriptSrc.includes("'unsafe-eval'"));
  assert.ok(!scriptSrc.includes('*'));

  const connectSrc = d.get('connect-src') || [];
  assert.ok(connectSrc.includes('https://*.googleapis.com'));
  assert.ok(connectSrc.includes('https://*.run.app'));
  assert.ok(!connectSrc.includes('*'));

  const frameSrc = d.get('frame-src') || [];
  assert.ok(frameSrc.includes('https://accounts.google.com'));
  assert.ok(frameSrc.includes('https://*.firebaseapp.com'));

  assert.doesNotMatch(csp, /http:\/\//i);
});
