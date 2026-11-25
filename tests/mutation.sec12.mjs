import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FILES = {
  sec: 'frontend/services/excelSecurity.ts',
  excel: 'frontend/services/excelService.ts',
  members: 'frontend/components/MembersView.tsx',
};

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')])
);
const testPath = path.join(REPO_ROOT, 'tests/sec12.depsExcel.test.mjs');

const mutants = [
  {
    id: 'E01',
    fileKey: 'sec',
    description: 'MAX_EXCEL_FILE_BYTES : relève limite à 50 Mo',
    target: 'export const MAX_EXCEL_FILE_BYTES = 5 * 1024 * 1024;',
    replacement: 'export const MAX_EXCEL_FILE_BYTES = 50 * 1024 * 1024;',
  },
  {
    id: 'E02',
    fileKey: 'sec',
    description: 'MAX_EXCEL_ROWS : relève limite à 100000 lignes',
    target: 'export const MAX_EXCEL_ROWS = 10000;',
    replacement: 'export const MAX_EXCEL_ROWS = 100000;',
  },
  {
    id: 'E03',
    fileKey: 'sec',
    description: 'validateExcelUploadFile : rejette borne exacte 5 Mo (>=)',
    target: 'if (file.size > MAX_EXCEL_FILE_BYTES) {',
    replacement: 'if (file.size >= MAX_EXCEL_FILE_BYTES) {',
  },
  {
    id: 'E04',
    fileKey: 'sec',
    description: 'validateExcelUploadFile : autorise toute extension',
    target: 'const hasAllowedExt = ALLOWED_EXCEL_EXTENSIONS.some((ext) => cleanName.endsWith(ext));',
    replacement: 'const hasAllowedExt = true;',
  },
  {
    id: 'E05',
    fileKey: 'sec',
    description: 'enforceExcelRowLimit : désactive limite MAX_EXCEL_ROWS',
    target: 'if (rows.length > MAX_EXCEL_ROWS) {',
    replacement: 'if (false && rows.length > MAX_EXCEL_ROWS) {',
  },
  {
    id: 'E06',
    fileKey: 'sec',
    description: 'sanitizeExcelTextCell : désactive neutralisation formule',
    target: 'const startsWithFormulaTrigger = /^[=+\\-@\\t\\r]/.test(text);',
    replacement: 'const startsWithFormulaTrigger = false;',
  },
  {
    id: 'E07',
    fileKey: 'sec',
    description: 'sanitizeExcelTextCell : altère nombre négatif valide',
    target: 'const isPlainNegativeNumber = /^-\\d+(\\.\\d+)?$/.test(text.trim());',
    replacement: 'const isPlainNegativeNumber = false;',
  },
  {
    id: 'E08',
    fileKey: 'sec',
    description: 'SAFE_XLSX_READ_OPTIONS : réactive cellFormula',
    target: '  cellFormula: false,',
    replacement: '  cellFormula: true,',
  },
  {
    id: 'E09',
    fileKey: 'excel',
    description: 'excelService : omet validation taille/extension avant XLSX.read',
    target: '  const fileCheck = validateExcelUploadFile(file);',
    replacement: '  const fileCheck = { valid: true };',
  },
  {
    id: 'E10',
    fileKey: 'members',
    description: 'MembersView : désactive SAFE_XLSX_READ_OPTIONS',
    target: "const wb = XLSX.read(bstr, { type: 'binary', ...SAFE_XLSX_READ_OPTIONS });",
    replacement: "const wb = XLSX.read(bstr, { type: 'binary' });",
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

console.log(`\nWeb SEC-12 Mutation Score: ${killed}/${mutants.length} killed, ${invalid} invalid, ${survivors.length} survived`);
if (invalid > 0 || survivors.length > 0) {
  process.exit(1);
}
