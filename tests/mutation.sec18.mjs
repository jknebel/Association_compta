import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const testPath = path.resolve(import.meta.dirname, 'sec18.mainHygiene.test.mjs');

const FILES = {
  gitignore: '.gitignore',
  deploy: '.github/workflows/deploy.yml',
  app: 'App.tsx',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);

const mutants = [
  {
    id: 'M01',
    fileKey: 'gitignore',
    description: '.gitignore : supprime __pycache__/',
    target: '\n__pycache__/\n',
    replacement: '\n',
  },
  {
    id: 'M02',
    fileKey: 'gitignore',
    description: '.gitignore : supprime *.py[cod]',
    target: '*.py[cod]\n',
    replacement: '',
  },
  {
    id: 'M03',
    fileKey: 'gitignore',
    description: '.gitignore : supprime .firebase/',
    target: '.firebase/\n',
    replacement: '',
  },
  {
    id: 'M04',
    fileKey: 'gitignore',
    description: '.gitignore : supprime * - Copie*',
    target: '* - Copie*\n',
    replacement: '',
  },
  {
    id: 'M05',
    fileKey: 'gitignore',
    description: '.gitignore : supprime .env.*',
    target: '.env.*',
    replacement: '',
  },
  {
    id: 'M06',
    fileKey: 'deploy',
    description: 'deploy.yml : supprime exécution tests SEC-18',
    target: '          node --test tests/sec18.mainHygiene.test.mjs\n',
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
    const res = spawnSync(process.execPath, ['--test', testPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    });
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

console.log(`\nSEC-18 (Web main) Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
