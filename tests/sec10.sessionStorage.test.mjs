import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WEB_MIGRATION_FLAG_KEY,
  WEB_SENSITIVE_STORAGE_KEYS,
  PROD_FIREBASE_MISSING_WEB_ERROR,
  canUseWebLocalMode,
  scopedWebStorageKey,
  purgeWebSensitiveStorage,
} from '../frontend/services/sessionSecurity.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function createMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  return {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
    removeItem(k) {
      store.delete(k);
    },
  };
}

test('[SEC-10][Positive] canUseWebLocalMode permits guest/unconfigured only outside PROD', () => {
  assert.equal(canUseWebLocalMode(false, false, false), true);
  assert.equal(canUseWebLocalMode(true, true, false), true);
  assert.equal(canUseWebLocalMode(false, true, false), true);
  assert.equal(canUseWebLocalMode(true, false, false), false);
});

test('[SEC-10][Negative] canUseWebLocalMode strictly disables local/demo mode in PROD', () => {
  assert.equal(canUseWebLocalMode(false, false, true), false);
  assert.equal(canUseWebLocalMode(false, true, true), false);
  assert.equal(canUseWebLocalMode(true, true, true), false);
  assert.equal(canUseWebLocalMode(true, false, true), false);
  assert.match(PROD_FIREBASE_MISSING_WEB_ERROR, /Configuration Firebase manquante/);
});

test('[SEC-10][Boundary] scopedWebStorageKey isolates uid-prefixed keys and handles empty/whitespace uid', () => {
  assert.equal(
    scopedWebStorageKey('asso_compta_accounts_v5', 'uid-alice'),
    'asso_compta_accounts_v5_uid-alice'
  );
  assert.equal(
    scopedWebStorageKey('asso_compta_accounts_v5', '  uid-bob  '),
    'asso_compta_accounts_v5_uid-bob'
  );
  assert.equal(scopedWebStorageKey('asso_compta_accounts_v5', ''), 'asso_compta_accounts_v5');
  assert.equal(scopedWebStorageKey('asso_compta_accounts_v5', '   '), 'asso_compta_accounts_v5');
  assert.equal(scopedWebStorageKey('asso_compta_accounts_v5', null), 'asso_compta_accounts_v5');
});

test('[SEC-10][Positive & Boundary] purgeWebSensitiveStorage removes base and enumerated uid keys while keeping migration flag and theme prefs', () => {
  const storage = createMockStorage({
    asso_compta_accounts_v5: '[{"id":"a1"}]',
    asso_compta_transactions_v5: '[{"id":"t1"}]',
    asso_compta_receipts_v5: '[{"id":"r1"}]',
    asso_compta_ai_context_v5: 'context',
    asso_compta_accounts_v5_alice: '[{"id":"a2"}]',
    asso_compta_transactions_v5_bob: '[{"id":"t2"}]',
    [WEB_MIGRATION_FLAG_KEY]: 'true',
    user_theme_pref: 'dark',
  });

  const removed = purgeWebSensitiveStorage(storage);
  assert.equal(removed, 6);
  for (const key of WEB_SENSITIVE_STORAGE_KEYS) {
    assert.equal(storage.getItem(key), null);
  }
  assert.equal(storage.getItem('asso_compta_accounts_v5_alice'), null);
  assert.equal(storage.getItem('asso_compta_transactions_v5_bob'), null);
  assert.equal(storage.getItem(WEB_MIGRATION_FLAG_KEY), 'true');
  assert.equal(storage.getItem('user_theme_pref'), 'dark');

  // Restricted storage without .length/.key still purges base keys
  const minMap = new Map([
    ['asso_compta_accounts_v5', '[]'],
    ['asso_compta_receipts_v5', '[]'],
    [WEB_MIGRATION_FLAG_KEY, 'true'],
  ]);
  const minimalStorage = {
    getItem: (k) => (minMap.has(k) ? minMap.get(k) : null),
    setItem: (k, v) => minMap.set(k, String(v)),
    removeItem: (k) => minMap.delete(k),
  };
  assert.equal(purgeWebSensitiveStorage(minimalStorage), 2);
  assert.equal(minimalStorage.getItem('asso_compta_accounts_v5'), null);
  assert.equal(minimalStorage.getItem(WEB_MIGRATION_FLAG_KEY), 'true');
});

test('[SEC-10][Integration] authService, dataService, and App wire SEC-10 controls cleanly', () => {
  const authSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/services/authService.ts'), 'utf8');
  assert.match(authSrc, /finally\s*\{[\s\S]*purgeWebSensitiveStorage\(/);

  const dataSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/services/dataService.ts'), 'utf8');
  assert.match(
    dataSrc,
    /const shouldUseLocalStorage = canUseWebLocalMode\(\s*isConfigured,\s*isGuest,\s*Boolean\(import\.meta\.env\.PROD\)\s*\);/
  );
  assert.match(dataSrc, /localStorage\.getItem\(accStorageKey\)/);
  assert.match(dataSrc, /localStorage\.setItem\(accStorageKey,/);
  assert.doesNotMatch(dataSrc, /localStorage\.getItem\('asso_compta_accounts_v5'\)/);

  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'App.tsx'), 'utf8');
  assert.match(appSrc, /if \(Boolean\(import\.meta\.env\.PROD\) && !isConfigured\)/);
  assert.match(appSrc, /PROD_FIREBASE_MISSING_WEB_ERROR/);
  assert.match(appSrc, /canUseWebLocalMode\(/);
});
