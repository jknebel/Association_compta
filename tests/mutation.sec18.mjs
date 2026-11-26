import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const testPath = path.join(REPO_ROOT, 'tests/sec18.hygieneAndLogs.test.mjs');

const FILES = {
  adminConfig: 'frontend/services/adminConfig.ts',
  appContext: 'frontend/contexts/AppContext.tsx',
  rentalNotif: 'frontend/services/rentalNotificationService.ts',
  gitignore: '.gitignore',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);

const mutants = [
  {
    id: 'H01',
    fileKey: 'adminConfig',
    description: 'adminConfig : retourne always true dans resolveSuperAdminAccess',
    target: '  if (params?.claims?.superAdmin === true) {',
    replacement: '  if (params?.claims?.superAdmin !== undefined || true) {',
  },
  {
    id: 'H02',
    fileKey: 'adminConfig',
    description: 'adminConfig : ignore la vérification === true du claim superAdmin',
    target: '  if (params?.claims?.superAdmin === true) {\n    return true;\n  }',
    replacement: '  if (Boolean(params?.claims?.superAdmin)) {\n    return true;\n  }',
  },
  {
    id: 'H03',
    fileKey: 'adminConfig',
    description: 'adminConfig : ignore rawEnv (force fallback même si env vaut NONE)',
    target: '  if (typeof rawEnv === \'string\' && rawEnv.trim().length > 0) {',
    replacement: '  if (false && typeof rawEnv === \'string\' && rawEnv.trim().length > 0) {',
  },
  {
    id: 'H04',
    fileKey: 'adminConfig',
    description: 'adminConfig : omet filtre item.includes(@) sur env',
    target: ".filter((item) => item.includes('@'))",
    replacement: '.filter((item) => item.length > 0)',
  },
  {
    id: 'H05',
    fileKey: 'adminConfig',
    description: 'adminConfig : retourne toujours false dans isEmailExemptFromVerification',
    target: '  return configured.includes(normEmail);',
    replacement: '  return configured.includes(normEmail) && false;',
  },
  {
    id: 'H06',
    fileKey: 'appContext',
    description: 'AppContext : réintroduit isHardcodedAdmin statique',
    target: '                const { resolveSuperAdminAccess } = await import(\'../services/adminConfig\');',
    replacement: '                const isHardcodedAdmin = user.email === \'jean.francois.knebel@gmail.com\'; void isHardcodedAdmin;\n                const { resolveSuperAdminAccess } = await import(\'../services/adminConfig\');',
  },
  {
    id: 'H07',
    fileKey: 'rentalNotif',
    description: 'rentalNotificationService : réintroduit fallback email personnel en dur',
    target: "caissierEmail: string = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_FALLBACK_CAISSIER_EMAIL || ''",
    replacement: "caissierEmail: string = 'jean.francois.knebel@gmail.com'",
  },
  {
    id: 'H08',
    fileKey: 'gitignore',
    description: '.gitignore : supprime .firebase/',
    target: '.firebase/\n',
    replacement: '',
  },
  {
    id: 'H09',
    fileKey: 'gitignore',
    description: '.gitignore : supprime *.py[cod]',
    target: '*.py[cod]\n',
    replacement: '',
  },
  {
    id: 'H10',
    fileKey: 'gitignore',
    description: '.gitignore : supprime * - Copie*',
    target: '* - Copie*\n',
    replacement: '',
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

console.log(`\nSEC-18 (Web JS/Hygiene) Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
