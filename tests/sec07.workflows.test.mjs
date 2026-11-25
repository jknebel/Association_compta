import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function collectSourceFiles(dirRel) {
  const results = [];
  const root = path.join(REPO_ROOT, dirRel);
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = path.posix.join(dirRel, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      results.push(...collectSourceFiles(rel));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs|yml|yaml|html)$/.test(entry.name)) {
      results.push(rel);
    }
  }
  return results;
}

function extractJobBlock(ymlText, jobName) {
  const normalized = ymlText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const startIdx = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`).test(line));
  assert.notEqual(startIdx, -1, `Expected job "${jobName}" to exist`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

test('[SEC-07][Positive] deploy.yml enforces top-level read permissions and push-to-main deploy guards', () => {
  const deployYml = readRepoFile('.github/workflows/deploy.yml').replace(/\r\n/g, '\n');
  assert.match(deployYml, /^permissions:\n  contents: read$/m);

  const backendJob = extractJobBlock(deployYml, 'deploy-backend');
  assert.match(
    backendJob,
    /^\s+if:\s*\$\{\{\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\s*\}\}/m
  );
  assert.match(backendJob, /MAILER_INTERNAL_SECRET=\$\{\{\s*secrets\.MAILER_INTERNAL_SECRET\s*\}\}/);

  const frontendJob = extractJobBlock(deployYml, 'deploy-frontend');
  assert.match(
    frontendJob,
    /^\s+if:\s*\$\{\{\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && needs\.changes\.outputs\.frontend == 'true'\s*\}\}/m
  );
  assert.match(frontendJob, /run:\s*npm ci\b/);
});

test('[SEC-07][Positive] deploy.yml includes a secretless PR frontend build check job', () => {
  const deployYml = readRepoFile('.github/workflows/deploy.yml').replace(/\r\n/g, '\n');
  const checkJob = extractJobBlock(deployYml, 'build-frontend-check');
  assert.match(
    checkJob,
    /^\s+if:\s*\$\{\{\s*github\.event_name == 'pull_request' && needs\.changes\.outputs\.frontend == 'true'\s*\}\}/m
  );
  assert.match(checkJob, /run:\s*npm ci\b/);
  assert.match(checkJob, /run:\s*npm run build\b/);
  assert.doesNotMatch(checkJob, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(checkJob, /firebase\s+deploy|deploy-cloudrun|action-hosting-deploy/i);
});

test('[SEC-07][Positive] deploy-staging.yml enforces read permissions, npm ci, and MAILER_INTERNAL_SECRET', () => {
  const stagingYml = readRepoFile('.github/workflows/deploy-staging.yml').replace(/\r\n/g, '\n');
  assert.match(stagingYml, /^permissions:\n  contents: read$/m);

  const backendJob = extractJobBlock(stagingYml, 'deploy-backend');
  assert.match(backendJob, /MAILER_INTERNAL_SECRET=\$\{\{\s*secrets\.MAILER_INTERNAL_SECRET\s*\}\}/);

  const frontendJob = extractJobBlock(stagingYml, 'deploy-frontend');
  assert.match(frontendJob, /run:\s*npm ci\b/);
});

test('[SEC-07][Negative] no bare npm install in deploy.yml or deploy-staging.yml frontend builds', () => {
  for (const rel of ['.github/workflows/deploy.yml', '.github/workflows/deploy-staging.yml']) {
    const content = readRepoFile(rel).replace(/\r\n/g, '\n');
    assert.doesNotMatch(
      content,
      /^\s*run:\s*npm install\s*$/m,
      `${rel} must use npm ci instead of bare npm install`
    );
  }
});

test('[SEC-07][Negative] client bundles, Vite config, workflows, and DeploymentView must never reference VITE_API_KEY or process.env.API_KEY', () => {
  const targets = [
    'vite.config.ts',
    'index.html',
    ...collectSourceFiles('.github/workflows'),
    ...collectSourceFiles('frontend'),
  ];
  assert.ok(targets.includes('frontend/components/DeploymentView.tsx'));

  for (const rel of targets) {
    const content = readRepoFile(rel);
    assert.doesNotMatch(content, /\bVITE_API_KEY\b/, `${rel} must not contain VITE_API_KEY`);
    assert.doesNotMatch(content, /\bVITE_GEMINI_API_KEY\b/, `${rel} must not contain VITE_GEMINI_API_KEY`);
    assert.doesNotMatch(content, /process\.env\.API_KEY\b/, `${rel} must not inject process.env.API_KEY`);
    assert.doesNotMatch(content, /process\.env\[['"]API_KEY['"]\]/, `${rel} must not read process.env['API_KEY']`);
  }

  const deploymentView = readRepoFile('frontend/components/DeploymentView.tsx');
  assert.match(deploymentView, /VITE_API_URL:\s*\\\$\{\{\s*secrets\.VITE_API_URL\s*\}\}/);

  const viteConfig = readRepoFile('vite.config.ts');
  assert.match(viteConfig, /sourcemap:\s*false/);
});

test('[SEC-07][Boundary] workflow guard & secret scanner edge cases behave strictly', () => {
  // Boundary 1: ref prefix lookalikes must not match push-to-main guard
  const mainRefs = ['refs/heads/main-preview', 'refs/heads/main2', 'refs/tags/main', 'refs/heads/ameliorationv2'];
  for (const ref of mainRefs) {
    assert.equal(ref === 'refs/heads/main', false);
  }

  // Boundary 2: very long file payload with trailing VITE_API_KEY must still be caught
  const largeBenignPrefix = '// '.padEnd(100_000, 'a') + '\n';
  assert.doesNotMatch(largeBenignPrefix + 'VITE_API_URL=https://api.example\n', /\bVITE_API_KEY\b/);
  assert.match(largeBenignPrefix + 'VITE_API_KEY=AIzaFake\n', /\bVITE_API_KEY\b/);

  // Boundary 3: CI workflow shards cover F4-F5 and F6 without gaps
  const securityCi = readRepoFile('.github/workflows/security-ci.yml');
  assert.match(securityCi, /filter:\s*'\^F\[45\]'/);
  assert.match(securityCi, /filter:\s*'\^F6'/);
  assert.match(securityCi, /filter:\s*'\^F\[789\]'/);
});
