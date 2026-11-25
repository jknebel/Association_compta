import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FILES = {
  html: 'index.html',
  fb: 'firebase.json',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);
const testPath = path.join(REPO_ROOT, 'tests/sec13.hostingHeaders.test.mjs');

const mutants = [
  {
    id: 'H01',
    fileKey: 'html',
    description: 'index.html : réintroduit script importmap aistudiocdn',
    target: '</head>',
    replacement: '  <script type="importmap">{"imports":{"react":"https://aistudiocdn.com/react"}}</script>\n</head>',
  },
  {
    id: 'H02',
    fileKey: 'fb',
    description: 'firebase.json : désactive Strict-Transport-Security',
    target: '"key": "Strict-Transport-Security",',
    replacement: '"key": "X-Disabled-HSTS",',
  },
  {
    id: 'H03',
    fileKey: 'fb',
    description: 'firebase.json : affaiblit X-Frame-Options DENY -> SAMEORIGIN',
    target: '"value": "DENY"',
    replacement: '"value": "SAMEORIGIN"',
  },
  {
    id: 'H04',
    fileKey: 'fb',
    description: 'firebase.json : retire X-Content-Type-Options nosniff',
    target: '"value": "nosniff"',
    replacement: '"value": "off"',
  },
  {
    id: 'H05',
    fileKey: 'fb',
    description: 'firebase.json : affaiblit Referrer-Policy',
    target: '"value": "strict-origin-when-cross-origin"',
    replacement: '"value": "unsafe-url"',
  },
  {
    id: 'H06',
    fileKey: 'fb',
    description: 'firebase.json : élargit Permissions-Policy caméra sur Web',
    target: '"value": "camera=(), microphone=(), geolocation=(), payment=()"',
    replacement: '"value": "camera=(*), microphone=()"',
  },
  {
    id: 'H07',
    fileKey: 'fb',
    description: 'firebase.json : retire Content-Security-Policy',
    target: '"key": "Content-Security-Policy",',
    replacement: '"key": "X-Report-Only-CSP",',
  },
  {
    id: 'H08',
    fileKey: 'fb',
    description: 'firebase.json : autorise unsafe-inline dans script-src',
    target: "script-src 'self' https://apis.google.com",
    replacement: "script-src 'self' 'unsafe-inline' https://apis.google.com",
  },
  {
    id: 'H09',
    fileKey: 'fb',
    description: 'firebase.json : retire frame-ancestors none du CSP',
    target: "; frame-ancestors 'none'",
    replacement: '',
  },
  {
    id: 'H10',
    fileKey: 'fb',
    description: 'firebase.json : casse popup Google Auth via COOP same-origin',
    target: '"key": "X-Frame-Options",',
    replacement: '"key": "Cross-Origin-Opener-Policy", "value": "same-origin" },\n          { "key": "X-Frame-Options",',
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

console.log(`\nWeb SEC-13 Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
