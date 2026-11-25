import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_EXCEL_FILE_BYTES,
  MAX_EXCEL_ROWS,
  ALLOWED_EXCEL_EXTENSIONS,
  SAFE_XLSX_READ_OPTIONS,
  validateExcelUploadFile,
  enforceExcelRowLimit,
  sanitizeExcelTextCell,
} from '../frontend/services/excelSecurity.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('[SEC-12][Positive] accepts valid .xlsx/.xls files up to 5 MiB and exact boundary row count', () => {
  assert.equal(MAX_EXCEL_FILE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_EXCEL_ROWS, 10000);
  assert.deepEqual(ALLOWED_EXCEL_EXTENSIONS, ['.xlsx', '.xls']);

  assert.equal(validateExcelUploadFile({ name: 'relevé_2026.xlsx', size: 1024 }).valid, true);
  assert.equal(validateExcelUploadFile({ name: 'ANCIEN.XLS', size: MAX_EXCEL_FILE_BYTES }).valid, true);

  const exactRows = new Array(MAX_EXCEL_ROWS).fill(['row']);
  assert.doesNotThrow(() => enforceExcelRowLimit(exactRows));

  assert.deepEqual(SAFE_XLSX_READ_OPTIONS, {
    sheetRows: 10001,
    cellFormula: false,
    cellHTML: false,
  });
});

test('[SEC-12][Negative & Boundary] rejects oversized, empty, malformed extension, and >10k rows files', () => {
  assert.equal(validateExcelUploadFile(null).valid, false);
  assert.equal(validateExcelUploadFile({ name: 'empty.xlsx', size: 0 }).valid, false);
  assert.equal(validateExcelUploadFile({ name: 'bomb.xlsx', size: MAX_EXCEL_FILE_BYTES + 1 }).valid, false);
  assert.equal(validateExcelUploadFile({ name: 'script.csv', size: 500 }).valid, false);
  assert.equal(validateExcelUploadFile({ name: 'fake.xlsx.exe', size: 500 }).valid, false);
  assert.equal(validateExcelUploadFile({ name: '', size: 500 }).valid, false);

  const tooManyRows = new Array(MAX_EXCEL_ROWS + 1).fill(['row']);
  assert.throws(() => enforceExcelRowLimit(tooManyRows), /Nombre de lignes Excel maximal dépassé/);
  assert.throws(() => enforceExcelRowLimit(null), /Contenu Excel invalide/);
});

test('[SEC-12][Positive & Negative] sanitizeExcelTextCell neutralizes formula injection while preserving numbers', () => {
  assert.equal(sanitizeExcelTextCell('=CMD("calc")'), "'=CMD(\"calc\")");
  assert.equal(sanitizeExcelTextCell('+SUM(A1:A2)'), "'+SUM(A1:A2)");
  assert.equal(sanitizeExcelTextCell('-1+cmd'), "'-1+cmd");
  assert.equal(sanitizeExcelTextCell('@HYPERLINK("http://x")'), "'@HYPERLINK(\"http://x\")");
  assert.equal(sanitizeExcelTextCell('\tmalicious'), "'\tmalicious");

  assert.equal(sanitizeExcelTextCell(-42.5), '-42.5');
  assert.equal(sanitizeExcelTextCell('-42.50'), '-42.50');
  assert.equal(sanitizeExcelTextCell('Cotisation 2026'), 'Cotisation 2026');
  assert.equal(sanitizeExcelTextCell(null), '');
});

test('[SEC-12][Supply Chain & Integration] package.json, requirements.txt, excelService, MembersView, and App follow SEC-12', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@google/genai'], undefined);
  assert.match(pkg.dependencies.xlsx, /^https:\/\/cdn\.sheetjs\.com\/xlsx-0\.20\.3\//);

  const reqs = fs.readFileSync(path.join(REPO_ROOT, 'backend/requirements.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(reqs.length >= 10);
  for (const line of reqs) {
    assert.match(line, /^[A-Za-z0-9._-]+==[0-9]/, `Requirement must be pinned: ${line}`);
  }

  const excelSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/services/excelService.ts'), 'utf8');
  assert.match(excelSrc, /validateExcelUploadFile\(file\)/);
  assert.match(excelSrc, /\.\.\.SAFE_XLSX_READ_OPTIONS/);
  assert.match(excelSrc, /enforceExcelRowLimit\(jsonData\)/);

  const membersSrc = fs.readFileSync(path.join(REPO_ROOT, 'frontend/components/MembersView.tsx'), 'utf8');
  assert.match(membersSrc, /validateExcelUploadFile\(file\)/);
  assert.match(membersSrc, /\.\.\.SAFE_XLSX_READ_OPTIONS/);
  assert.match(membersSrc, /enforceExcelRowLimit\(data\)/);

  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'App.tsx'), 'utf8');
  assert.doesNotMatch(appSrc, /import \* as XLSX from 'xlsx'/);
});
