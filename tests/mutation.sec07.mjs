import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const testPath = path.resolve(import.meta.dirname, 'sec07.workflows.test.mjs');

const FILES = {
  deploy: '.github/workflows/deploy.yml',
  staging: '.github/workflows/deploy-staging.yml',
  deploymentView: 'frontend/components/DeploymentView.tsx',
  viteConfig: 'vite.config.ts',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);

const mutants = [
  {
    id: 'W01',
    fileKey: 'deploy',
    description: 'deploy.yml : suppression permissions top-level contents: read',
    target: 'permissions:\n  contents: read\n',
    replacement: '',
  },
  {
    id: 'W02',
    fileKey: 'deploy',
    description: 'deploy.yml : suppression garde push-main sur deploy-backend',
    target: "if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    replacement: "if: ${{ always() }}",
  },
  {
    id: 'W03',
    fileKey: 'deploy',
    description: 'deploy.yml : suppression garde push-main sur deploy-frontend',
    target: "if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.changes.outputs.frontend == 'true' }}",
    replacement: "if: ${{ needs.changes.outputs.frontend == 'true' }}",
  },
  {
    id: 'W04',
    fileKey: 'deploy',
    description: 'deploy.yml : remplacement npm ci par npm install dans deploy-frontend',
    target: '  # 5. BUILD & DEPLOY FRONTEND (Firebase Hosting - Only on push to main)',
    replacement: '  # 5. BUILD & DEPLOY FRONTEND',
    customMutate(content) {
      const idx = content.indexOf('  deploy-frontend:');
      if (idx === -1) return null;
      const head = content.slice(0, idx);
      const tail = content.slice(idx).replace('run: npm ci', 'run: npm install');
      return head + tail === content ? null : head + tail;
    },
  },
  {
    id: 'W05',
    fileKey: 'deploy',
    description: 'deploy.yml : suppression MAILER_INTERNAL_SECRET de deploy-backend',
    target: '            MAILER_INTERNAL_SECRET=${{ secrets.MAILER_INTERNAL_SECRET }}\n',
    replacement: '',
  },
  {
    id: 'W06',
    fileKey: 'staging',
    description: 'deploy-staging.yml : suppression permissions top-level contents: read',
    target: 'permissions:\n  contents: read\n',
    replacement: '',
  },
  {
    id: 'W07',
    fileKey: 'staging',
    description: 'deploy-staging.yml : remplacement npm ci par npm install',
    target: 'run: npm ci',
    replacement: 'run: npm install',
  },
  {
    id: 'W08',
    fileKey: 'staging',
    description: 'deploy-staging.yml : suppression MAILER_INTERNAL_SECRET',
    target: '            MAILER_INTERNAL_SECRET=${{ secrets.MAILER_INTERNAL_SECRET }}\n',
    replacement: '',
  },
  {
    id: 'W09',
    fileKey: 'deploymentView',
    description: 'DeploymentView.tsx : réintroduction de VITE_API_KEY',
    target: 'VITE_API_URL: \\${{ secrets.VITE_API_URL }}',
    replacement: 'VITE_API_KEY: \\${{ secrets.VITE_API_KEY }}',
  },
  {
    id: 'W10',
    fileKey: 'viteConfig',
    description: 'vite.config.ts : réinjection de process.env.API_KEY',
    target: '  plugins: [react()],',
    replacement: "  plugins: [react()],\n  define: { 'process.env.API_KEY': JSON.stringify(process.env.VITE_API_KEY) },",
  },
];

function applyMutation(content, m) {
  const normalized = content.replace(/\r\n/g, '\n');
  if (m.customMutate) {
    return m.customMutate(normalized);
  }
  if (!normalized.includes(m.target)) {
    return null;
  }
  return normalized.replace(m.target, m.replacement);
}

let killed = 0;
let invalid = 0;
const survivors = [];

try {
  for (const m of mutants) {
    const absPath = path.join(REPO_ROOT, FILES[m.fileKey]);
    const orig = originals[m.fileKey];
    const mutated = applyMutation(orig, m);
    if (mutated === null) {
      console.error(`[INVALID] ${m.id} (${m.description}): target not matched in ${FILES[m.fileKey]}`);
      invalid += 1;
      continue;
    }

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

console.log(`\nSEC-07 Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
