import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

test('[SEC-18][Positive] .gitignore enforces cache, bytecode, copy artifact, and env variant exclusions', () => {
  const lines = new Set(
    fs
      .readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
  );
  for (const pattern of ['__pycache__/', '*.py[cod]', '.firebase/', '* - Copie*', '.env.*']) {
    assert.ok(lines.has(pattern), `.gitignore missing standalone rule ${pattern}`);
  }
});

test('[SEC-18][Negative] legacy Copie, pyc bytecode, and duplicate root SettingsView are removed from main', () => {
  for (const forbidden of [
    'backend/Dockerfile - Copie',
    'backend/requirements - Copie.txt',
    'backend/__pycache__/main.cpython-313.pyc',
    'components/SettingsView.tsx',
  ]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, forbidden)), false, `${forbidden} must not exist on main`);
  }
});

test('[SEC-18][Boundary & Integration] App.tsx still resolves active frontend SettingsView & deploy.yml gates SEC-18 CI', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'frontend/components/SettingsView.tsx')), true);
  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'App.tsx'), 'utf8');
  assert.match(appSrc, /['"]\.\/frontend\/components\/SettingsView['"]/);

  const deployYml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(deployYml, /node --test tests\/sec18\.mainHygiene\.test\.mjs/);
  assert.match(deployYml, /node tests\/mutation\.sec18\.mjs/);
});
