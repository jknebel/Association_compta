import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FILES = {
  dockerfile: 'backend/Dockerfile',
  dockerignore: 'backend/.dockerignore',
  cron: '.github/workflows/friday-reimbursements-digest.yml',
  ci: '.github/workflows/security-ci.yml',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);
const testPath = path.join(REPO_ROOT, 'tests/sec16.dockerAndCron.test.mjs');

const mutants = [
  {
    id: 'C01',
    fileKey: 'dockerfile',
    description: 'Dockerfile : revient à exécution en tant que root (supprime USER appuser)',
    target: 'USER appuser',
    replacement: 'USER root',
  },
  {
    id: 'C02',
    fileKey: 'dockerfile',
    description: 'Dockerfile : retire --chown=appuser:appuser du COPY',
    target: 'COPY --chown=appuser:appuser . ./',
    replacement: 'COPY . ./',
  },
  {
    id: 'C03',
    fileKey: 'dockerfile',
    description: 'Dockerfile : déplace USER appuser après CMD',
    target: 'USER appuser\nEXPOSE 8080\n\n# Cloud Run expects the app to listen on PORT environment variable\nCMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]',
    replacement: 'EXPOSE 8080\nCMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]\nUSER appuser',
  },
  {
    id: 'C04',
    fileKey: 'dockerignore',
    description: '.dockerignore : expose fichiers .env*',
    target: '.env.*\n',
    replacement: '',
  },
  {
    id: 'C05',
    fileKey: 'dockerignore',
    description: '.dockerignore : inclut fichiers serviceAccount*.json dans l image',
    target: 'serviceAccount*.json',
    replacement: '# disabled',
  },
  {
    id: 'C06',
    fileKey: 'dockerignore',
    description: '.dockerignore : inclut tests/ dans le contexte Docker',
    target: 'tests/\n',
    replacement: '',
  },
  {
    id: 'C07',
    fileKey: 'cron',
    description: 'friday-digest : supprime permissions contents: read',
    target: 'permissions:\n  contents: read',
    replacement: 'permissions:\n  contents: write',
  },
  {
    id: 'C08',
    fileKey: 'cron',
    description: 'friday-digest : réintroduit secret GCP_SA_KEY brut en env',
    target: '      - name: Vérifier statut synthèse hebdomadaire',
    replacement: '      - name: Vérifier statut synthèse hebdomadaire\n        env:\n          GCP_SA_KEY: ${{ secrets.GCP_SA_KEY }}',
  },
  {
    id: 'C09',
    fileKey: 'cron',
    description: 'friday-digest : réintroduit cron cassé sans vérifier présence du script',
    target: '          if [ -f "Script/send_friday_reimbursements_digest.mjs" ]; then',
    replacement: '          if true; then',
  },
  {
    id: 'C10',
    fileKey: 'ci',
    description: 'security-ci.yml : supprime vérification docker appuser',
    target: 'test "$(docker run --rm --entrypoint id assocompta-backend:sec16 -un)" = "appuser"',
    replacement: 'true',
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

console.log(`\nWeb SEC-16 Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
