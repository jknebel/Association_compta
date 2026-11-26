import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FILES = {
  crypto: 'frontend/services/cryptoRandom.ts',
  org: 'frontend/services/organizationService.ts',
  rental: 'frontend/services/rentalService.ts',
  login: 'frontend/components/LoginView.tsx',
  py: 'backend/main.py',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);
const testPath = path.join(REPO_ROOT, 'tests/sec17.cryptoAndPassword.test.mjs');

const mutants = [
  {
    id: 'K01',
    fileKey: 'crypto',
    description: 'MIN_SIGNUP_PASSWORD_LENGTH : baisse limite inscription à 6 caractères',
    target: 'export const MIN_SIGNUP_PASSWORD_LENGTH = 12;',
    replacement: 'export const MIN_SIGNUP_PASSWORD_LENGTH = 6;',
  },
  {
    id: 'K02',
    fileKey: 'crypto',
    description: 'validateSignupPasswordPolicy : bloque anciens utilisateurs (< 12 au login)',
    target: '  if (pwd.length < MIN_LOGIN_PASSWORD_LENGTH) {',
    replacement: '  if (pwd.length < MIN_SIGNUP_PASSWORD_LENGTH) {',
  },
  {
    id: 'K03',
    fileKey: 'crypto',
    description: 'validateSignupPasswordPolicy : contourne vérification signup (< -> <= 0)',
    target: 'if (pwd.length < MIN_SIGNUP_PASSWORD_LENGTH) {',
    replacement: 'if (pwd.length < 0) {',
  },
  {
    id: 'K04',
    fileKey: 'crypto',
    description: 'generateSecureHexToken : n appelle plus cryptoObj.getRandomValues(buf)',
    target: '  cryptoObj.getRandomValues(buf);',
    replacement: '  buf.fill(0);',
  },
  {
    id: 'K05',
    fileKey: 'crypto',
    description: 'generateSecureInviteCode : entropie réduite à 4 octets',
    target: 'export function generateSecureInviteCode(byteLength: number = 16): string {',
    replacement: 'export function generateSecureInviteCode(byteLength: number = 4): string {',
  },
  {
    id: 'K06',
    fileKey: 'org',
    description: 'organizationService : réintroduit Math.random pour initialInviteCode',
    target: 'const initialInviteCode = generateSecureInviteCode();',
    replacement: 'const initialInviteCode = Math.random().toString(36).substring(2, 10);',
  },
  {
    id: 'K07',
    fileKey: 'rental',
    description: 'rentalService : réintroduit Math.random pour rentalId',
    target: "const rentalId = generateSecureEntityId('rental');",
    replacement: "const rentalId = `rental-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;",
  },
  {
    id: 'K08',
    fileKey: 'login',
    description: 'LoginView : supprime validation password dans handleSubmit',
    target: 'const pwCheck = validateSignupPasswordPolicy(password, isSignUp);',
    replacement: 'const pwCheck = { valid: true };',
  },
  {
    id: 'K09',
    fileKey: 'login',
    description: 'LoginView : réintroduit minLength={6} statique au lieu du guard isSignUp',
    target: 'minLength={isSignUp ? MIN_SIGNUP_PASSWORD_LENGTH : MIN_LOGIN_PASSWORD_LENGTH}',
    replacement: 'minLength={6}',
  },
  {
    id: 'K10',
    fileKey: 'py',
    description: 'backend/main.py : réintroduit hashlib.md5 au lieu de sha256',
    target: 'txn_id = hashlib.sha256(f"{date_str}|{description}|{amount}".encode("utf-8")).hexdigest()[:32]',
    replacement: 'txn_id = hashlib.md5(f"{date_str}|{description}|{amount}".encode()).hexdigest()',
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

console.log(`\nWeb SEC-17 Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
