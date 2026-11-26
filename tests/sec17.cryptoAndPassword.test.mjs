import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_SIGNUP_PASSWORD_LENGTH,
  MIN_LOGIN_PASSWORD_LENGTH,
  generateSecureHexToken,
  generateSecureInviteCode,
  generateSecureShortToken,
  generateSecureEntityId,
  validateSignupPasswordPolicy,
} from '../frontend/services/cryptoRandom.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...collectTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('[SEC-17][Positive] CSPRNG token and invite generators produce high-entropy hex strings without duplicates', () => {
  const code1 = generateSecureInviteCode();
  const code2 = generateSecureInviteCode();
  assert.equal(code1.length, 32);
  assert.match(code1, /^[0-9a-f]{32}$/);
  assert.notEqual(code1, code2);

  const shortTok = generateSecureShortToken(6);
  assert.match(shortTok, /^[0-9a-f]{12}$/);

  const id = generateSecureEntityId('rcpt');
  assert.match(id, /^rcpt-\d+-[0-9a-f]{12}$/);
  assert.equal(generateSecureHexToken(0).length, 32);
});

test('[SEC-17][Positive & Negative & Boundary] validateSignupPasswordPolicy enforces 12+ chars on signup while preserving 6-char login', () => {
  assert.equal(MIN_SIGNUP_PASSWORD_LENGTH, 12);
  assert.equal(MIN_LOGIN_PASSWORD_LENGTH, 6);

  // Signup boundaries: 11 rejected, 12 accepted
  assert.equal(validateSignupPasswordPolicy('a'.repeat(11), true).valid, false);
  assert.equal(validateSignupPasswordPolicy('a'.repeat(12), true).valid, true);
  assert.equal(validateSignupPasswordPolicy('', true).valid, false);

  // Existing account login boundaries: 5 rejected, 6 accepted (no user lockout)
  assert.equal(validateSignupPasswordPolicy('a'.repeat(5), false).valid, false);
  assert.equal(validateSignupPasswordPolicy('a'.repeat(6), false).valid, true);
});

test('[SEC-17][Negative & Integration] zero Math.random in frontend sources, zero hashlib.md5 in backend/main.py, LoginView enforces policy', () => {
  const tsFiles = [...collectTsFiles(path.join(REPO_ROOT, 'frontend')), path.join(REPO_ROOT, 'App.tsx')];
  for (const f of tsFiles) {
    const content = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(content, /Math\.random\s*\(/, `Math.random found in ${path.relative(REPO_ROOT, f)}`);
  }

  const backendMain = fs.readFileSync(path.join(REPO_ROOT, 'backend/main.py'), 'utf8');
  assert.doesNotMatch(backendMain, /hashlib\.md5\s*\(/);
  assert.match(backendMain, /hashlib\.sha256\([^\r\n]+\)\.hexdigest\(\)\[:32\]/);

  const loginSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/components/LoginView.tsx'), 'utf8');
  assert.match(loginSrc, /validateSignupPasswordPolicy\(password,\s*isSignUp\)/);
  assert.match(loginSrc, /minLength=\{isSignUp \? MIN_SIGNUP_PASSWORD_LENGTH : MIN_LOGIN_PASSWORD_LENGTH\}/);
});
