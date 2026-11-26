import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SUPER_ADMIN_EMAILS,
  DEFAULT_EXEMPT_VERIFICATION_EMAILS,
  parseConfiguredEmails,
  resolveSuperAdminAccess,
  isEmailExemptFromVerification,
} from '../frontend/services/adminConfig.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('[SEC-18][Positive] env-configurable super-admin & verification exemption helpers respect claims and defaults', () => {
  assert.deepEqual(
    parseConfiguredEmails(' Admin@Asso.ch ; treasurer@asso.ch '),
    ['admin@asso.ch', 'treasurer@asso.ch']
  );

  // Token custom claim superAdmin === true grants access regardless of email list
  assert.equal(
    resolveSuperAdminAccess({
      claims: { superAdmin: true },
      email: 'member@asso.ch',
      rawSuperAdminEmailsEnv: 'NONE',
    }),
    true
  );

  // Explicit env list overrides default fallback
  assert.equal(
    resolveSuperAdminAccess({
      claims: {},
      email: 'ADMIN@ASSO.CH',
      rawSuperAdminEmailsEnv: 'admin@asso.ch',
    }),
    true
  );

  // Fallback defaults still work when env var is unset
  assert.equal(
    resolveSuperAdminAccess({
      claims: {},
      email: DEFAULT_SUPER_ADMIN_EMAILS[0],
      rawSuperAdminEmailsEnv: '',
    }),
    true
  );

  assert.equal(
    isEmailExemptFromVerification(DEFAULT_EXEMPT_VERIFICATION_EMAILS[2], ''),
    true
  );
  assert.equal(
    isEmailExemptFromVerification('quokka@tdgl.ch', ''),
    true
  );
});

test('[SEC-18][Negative] disables hardcoded email fallbacks when env explicitly disables them & rejects non-admins', () => {
  assert.deepEqual(parseConfiguredEmails('NONE'), []);
  assert.equal(
    resolveSuperAdminAccess({
      claims: { superAdmin: false },
      email: DEFAULT_SUPER_ADMIN_EMAILS[0],
      rawSuperAdminEmailsEnv: 'NONE',
    }),
    false
  );
  assert.equal(
    resolveSuperAdminAccess({
      claims: null,
      email: 'ordinary@member.ch',
      rawSuperAdminEmailsEnv: '',
    }),
    false
  );
  assert.equal(
    isEmailExemptFromVerification(DEFAULT_EXEMPT_VERIFICATION_EMAILS[0], 'NONE'),
    false
  );
  assert.equal(isEmailExemptFromVerification('other@member.ch', 'NONE'), false);
});

test('[SEC-18][Boundary] handles null, malformed tokens, deduplication, and repository hygiene invariants', () => {
  assert.deepEqual(parseConfiguredEmails('invalid, ,, a@b.ch, A@B.CH'), ['a@b.ch']);
  assert.equal(resolveSuperAdminAccess({ claims: { superAdmin: 'true' }, email: null }), false);
  assert.equal(isEmailExemptFromVerification('   ', '   '), false);

  // No hardcoded personal email in notification fallbacks or AppContext
  const rentalNotifSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/services/rentalNotificationService.ts'),
    'utf8'
  );
  assert.doesNotMatch(rentalNotifSrc, /jean\.francois\.knebel@gmail\.com/i);

  const appCtxSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/contexts/AppContext.tsx'),
    'utf8'
  );
  assert.doesNotMatch(appCtxSrc, /isHardcodedAdmin/);
  assert.match(appCtxSrc, /resolveSuperAdminAccess/);

  const userSvcSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'frontend/services/userService.ts'),
    'utf8'
  );
  assert.match(userSvcSrc, /VITE_EXEMPT_VERIFICATION_EMAILS/);

  // Tracked temporary / duplicate / pyc / firebase cache artifacts must remain absent
  for (const forbidden of [
    '.firebase/hosting.ZGlzdA.cache',
    'backend/Dockerfile - Copie',
    'backend/requirements - Copie.txt',
    'backend/__pycache__/main.cpython-313.pyc',
  ]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, forbidden)), false, `${forbidden} must not exist`);
  }

  // .gitignore must guard cache, backup copies, pyc, and env variants
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  for (const pattern of ['__pycache__/', '*.py[cod]', '.firebase/', '* - Copie*', '.env.*']) {
    assert.ok(gitignore.includes(pattern), `.gitignore missing ${pattern}`);
  }
});
