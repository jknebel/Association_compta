import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetFile = path.resolve(__dirname, '../reimbursementMatching.ts');
const testFile = path.resolve(__dirname, './reimbursement.web04.test.mjs');

const originalCode = fs.readFileSync(targetFile, 'utf8');

const mutants = [
  {
    name: 'M1: Inversion du bonus J / J+1 pour DEBIT_CARD (score += 20 -> score -= 20)',
    target: 'score += 20;',
    replacement: 'score -= 20;',
  },
  {
    name: 'M2: Suppression du rejet hors délai pour DEBIT_CARD (return -1 -> score += 10)',
    target: '// Hors délai pour une carte de débit/crédit\n        return -1;',
    replacement: '// Hors délai pour une carte de débit/crédit\n        score += 10;',
  },
  {
    name: 'M3: Rejet des remboursements au-delà de 7 jours (diffDays > 365 -> diffDays > 7)',
    target: 'if (diffDays < -7 || diffDays > 365) {',
    replacement: 'if (diffDays < -7 || diffDays > 7) {',
  },
  {
    name: 'M4: Suppression du bonus Nom de famille sur REIMBURSEMENT (score += 12 -> score += 0)',
    target: 'score += 12;',
    replacement: 'score += 0;',
  },
  {
    name: 'M5: Inversion du biffage dans toggleReceiptReimbursed (REIMBURSED -> PENDING)',
    target: "reimbursementStatus: 'REIMBURSED',",
    replacement: "reimbursementStatus: 'PENDING',",
  },
  {
    name: 'M6: Suppression du filtre expenseType === REIMBURSEMENT dans computeReimbursementStats',
    target: "const reimbursements = receipts.filter((r) => r.expenseType === 'REIMBURSEMENT');",
    replacement: 'const reimbursements = receipts;',
  },
  {
    name: 'M7: Inversion du prénom et du nom dans splitSubmitterIdentity',
    target: 'const firstName = parts[0];\n    const lastName = parts.slice(1).join(\' \');',
    replacement: 'const firstName = parts.slice(1).join(\' \');\n    const lastName = parts[0];',
  },
  {
    name: 'M8: Désactivation du rapprochement dans matchTransactionsWithReceipts (score >= 15 -> score >= 999)',
    target: 'if (score >= 15 && score > bestScore) {',
    replacement: 'if (score >= 999 && score > bestScore) {',
  },
];

let killed = 0;
const normalizedOriginal = originalCode.replace(/\r\n/g, '\n');

try {
  for (const m of mutants) {
    if (!normalizedOriginal.includes(m.target)) {
      console.error(`❌ Cible introuvable pour ${m.name}`);
      process.exit(1);
    }
    const mutated = normalizedOriginal.replace(m.target, m.replacement);
    fs.writeFileSync(targetFile, mutated, 'utf8');

    const res = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--test', testFile],
      { encoding: 'utf8' }
    );

    if (res.status !== 0) {
      killed++;
      console.log(`✅ TUÉ : ${m.name}`);
    } else {
      console.error(`❌ SURVIVANT : ${m.name}`);
    }
  }
} finally {
  fs.writeFileSync(targetFile, originalCode, 'utf8');
}

const score = Math.round((killed / mutants.length) * 100);
console.log(`\nScore de mutation WEB-04 : ${killed}/${mutants.length} (${score}%)`);
if (killed !== mutants.length) process.exit(1);
