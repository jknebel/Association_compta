import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FILES = {
  sec: 'frontend/services/sessionSecurity.ts',
  auth: 'frontend/services/authService.ts',
  data: 'frontend/services/dataService.ts',
  app: 'App.tsx',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);
const testPath = path.join(REPO_ROOT, 'tests/sec10.sessionStorage.test.mjs');

const mutants = [
  {
    id: 'S01',
    fileKey: 'sec',
    description: 'canUseWebLocalMode : autorise mode local/démo en PROD',
    target: 'if (isProd) return false;',
    replacement: 'if (false && isProd) return false;',
  },
  {
    id: 'S02',
    fileKey: 'sec',
    description: 'canUseWebLocalMode : autorise mode local même configuré et non invité',
    target: 'return Boolean(isGuest || !isConfigured);',
    replacement: 'return true;',
  },
  {
    id: 'S03',
    fileKey: 'sec',
    description: 'scopedWebStorageKey : ignore uid et retourne clé partagée',
    target: 'return cleanUid ? `${baseKey}_${cleanUid}` : baseKey;',
    replacement: 'return baseKey;',
  },
  {
    id: 'S04',
    fileKey: 'sec',
    description: 'isSensitiveKey : ignore clés préfixées par uid',
    target: '(prefix) => key === prefix || key.startsWith(`${prefix}_`)',
    replacement: '(prefix) => key === prefix',
  },
  {
    id: 'S05',
    fileKey: 'sec',
    description: 'purgeWebSensitiveStorage : ne seed pas WEB_SENSITIVE_STORAGE_KEYS',
    target: 'const keysToRemove = new Set<string>(WEB_SENSITIVE_STORAGE_KEYS);',
    replacement: 'const keysToRemove = new Set<string>();',
  },
  {
    id: 'S06',
    fileKey: 'sec',
    description: 'isSensitiveKey : supprime aussi le flag de migration non sensible',
    target: 'if (key === WEB_MIGRATION_FLAG_KEY) return false;',
    replacement: 'if (key === WEB_MIGRATION_FLAG_KEY) return true;',
  },
  {
    id: 'S07',
    fileKey: 'auth',
    description: 'logout : ne purge plus localStorage dans finally',
    target: 'purgeWebSensitiveStorage(',
    replacement: 'void (',
  },
  {
    id: 'S08',
    fileKey: 'data',
    description: 'dataService : ignore canUseWebLocalMode PROD guard',
    target: '    const shouldUseLocalStorage = canUseWebLocalMode(\n        isConfigured,\n        isGuest,\n        Boolean(import.meta.env.PROD)\n    );',
    replacement: '    const shouldUseLocalStorage = isGuest || !isConfigured;',
  },
  {
    id: 'S09',
    fileKey: 'data',
    description: 'dataService : lit clé statique partagée au lieu de accStorageKey',
    target: 'const savedAcc = localStorage.getItem(accStorageKey);',
    replacement: "const savedAcc = localStorage.getItem('asso_compta_accounts_v5');",
  },
  {
    id: 'S10',
    fileKey: 'app',
    description: 'App : supprime blocage PROD sans configuration Firebase',
    target: 'if (Boolean(import.meta.env.PROD) && !isConfigured) {',
    replacement: 'if (false && Boolean(import.meta.env.PROD) && !isConfigured) {',
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
      survivors.push(m);
      console.error(`[SURVIVED] ${m.id}: ${m.description}`);
    }
  }
} finally {
  for (const [k, orig] of Object.entries(originals)) {
    fs.writeFileSync(path.join(REPO_ROOT, FILES[k]), orig, 'utf8');
  }
}

console.log(`\nWeb SEC-10 Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
