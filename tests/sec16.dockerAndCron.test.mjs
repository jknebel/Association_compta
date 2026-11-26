import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('[SEC-16][Positive] backend/Dockerfile enforces non-root appuser and safe Python env', () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'backend/Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM python:3\.11-slim$/m);
  assert.match(dockerfile, /^ENV PYTHONDONTWRITEBYTECODE=1$/m);
  assert.match(dockerfile, /^ENV PYTHONUNBUFFERED=1$/m);
  assert.match(dockerfile, /useradd\s+--uid\s+10001\b[\s\S]*appuser/);
  assert.match(dockerfile, /COPY\s+--chown=appuser:appuser\s+\.\s+\.\/$/m);
  assert.match(dockerfile, /^USER appuser$/m);
  assert.doesNotMatch(dockerfile, /^USER root$/m);

  const userIdx = dockerfile.lastIndexOf('USER appuser');
  const cmdIdx = dockerfile.lastIndexOf('CMD ');
  assert.ok(userIdx > 0 && cmdIdx > userIdx, 'USER appuser must precede CMD');
});

test('[SEC-16][Positive & Negative] backend/.dockerignore excludes secrets, caches, tests, and Copie files', () => {
  const ignore = fs.readFileSync(path.join(REPO_ROOT, 'backend/.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const required of ['__pycache__/', '*.py[cod]', 'tests/', '.env', '.env.*', '*Copie*', 'serviceAccount*.json']) {
    assert.ok(ignore.includes(required), `.dockerignore must include ${required}`);
  }
});

test('[SEC-16][Negative & Integration] friday-reimbursements-digest.yml locks permissions, removes raw GCP_SA_KEY & broken cron', () => {
  const wf = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/friday-reimbursements-digest.yml'),
    'utf8'
  );
  assert.match(wf, /^permissions:\r?\n\s+contents:\s*read\s*$/m);
  assert.doesNotMatch(wf, /^\s+schedule:/m);
  assert.doesNotMatch(wf, /GCP_SA_KEY/);
  assert.match(wf, /node-version:\s*'22'/);
  assert.match(wf, /run:\s*npm ci\b/);
  assert.match(wf, /if\s+\[\s*-f\s+"Script\/send_friday_reimbursements_digest\.mjs"\s*\]/);
});

test('[SEC-16][Integration] security-ci.yml builds backend container and verifies non-root uid/user', () => {
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/security-ci.yml'), 'utf8');
  assert.match(ci, /docker build -t assocompta-backend:sec16 \.\/backend/);
  assert.match(ci, /--entrypoint id assocompta-backend:sec16 -un\)" = "appuser"/);
  assert.match(ci, /--entrypoint id assocompta-backend:sec16 -u\)" = "10001"/);
});
