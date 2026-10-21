import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const targetPath = path.resolve(import.meta.dirname, '../receiptTransfer.ts');
const testPath = path.resolve(import.meta.dirname, './receiptTransfer.web03.test.mjs');
const originalCode = fs.readFileSync(targetPath, 'utf8');

const mutants = [
    {
        id: 'MUT-01',
        description: 'canTransferReceipt : autoriser à tort viewer',
        target: "return norm === 'caissier' || norm === 'comptable' || norm === 'admin';",
        replacement: "return norm === 'caissier' || norm === 'comptable' || norm === 'admin' || norm === 'viewer';"
    },
    {
        id: 'MUT-02',
        description: 'canTransferReceipt : inversion superAdmin check',
        target: 'if (isSuperAdmin === true || isOrgAdmin === true) return true;',
        replacement: 'if (isSuperAdmin === false && isOrgAdmin === false) return true;'
    },
    {
        id: 'MUT-03',
        description: 'getEligibleTargetComptas : ne pas exclure fromComptaId',
        target: 'c.id !== fromComptaId',
        replacement: 'true'
    },
    {
        id: 'MUT-04',
        description: 'getEligibleTargetComptas : inclure les archivées',
        target: 'c.isArchived !== true',
        replacement: 'true'
    },
    {
        id: 'MUT-05',
        description: 'validateReceiptTransfer : inversion vérification même compta cible',
        target: 'if (targetCompta.id === fromComptaId)',
        replacement: 'if (targetCompta.id !== fromComptaId)'
    },
    {
        id: 'MUT-06',
        description: 'validateReceiptTransfer : omission vérification hasActiveLink',
        target: 'if (hasActiveLink) return',
        replacement: 'if (false && hasActiveLink) return'
    },
    {
        id: 'MUT-07',
        description: 'validateReceiptTransfer : inversion limite MAX_TRANSFER_NOTE_LENGTH (> -> <)',
        target: 'if (normalizeTransferNote(note).length > MAX_TRANSFER_NOTE_LENGTH)',
        replacement: 'if (normalizeTransferNote(note).length < MAX_TRANSFER_NOTE_LENGTH)'
    },
    {
        id: 'MUT-08',
        description: 'isSafeDocId : autoriser les slashs',
        target: '!id.includes(\'/\')',
        replacement: 'true'
    },
    {
        id: 'MUT-09',
        description: 'buildTransferredReceipt : statut fixé à ACCEPTED au lieu de PENDING_ACCEPTANCE',
        target: "status: 'PENDING_ACCEPTANCE'",
        replacement: "status: 'ACCEPTED'"
    },
    {
        id: 'MUT-10',
        description: 'buildTransferredReceipt : suppression de la coupure d historique slice(-MAX_TRANSFER_HISTORY)',
        target: '.slice(-MAX_TRANSFER_HISTORY);',
        replacement: ';'
    },
    {
        id: 'MUT-11',
        description: 'buildAcceptedReceipt : inversion vérification PENDING_ACCEPTANCE',
        target: "if (current.status !== 'PENDING_ACCEPTANCE')",
        replacement: "if (current.status === 'PENDING_ACCEPTANCE')"
    },
    {
        id: 'MUT-12',
        description: 'isPendingIncomingTransfer : omission vérification toComptaId === currentComptaId',
        target: 'tr.toComptaId === currentComptaId',
        replacement: 'true'
    },
    {
        id: 'MUT-13',
        description: 'performReceiptTransfer : omission suppression source (tx.delete)',
        target: 'tx.delete(sourcePath);',
        replacement: '// tx.delete(sourcePath);'
    },
    {
        id: 'MUT-14',
        description: 'performReceiptTransfer : inversion check collision targetSnap.exists',
        target: 'if (targetSnap.exists) throw new Error',
        replacement: 'if (!targetSnap.exists && false) throw new Error'
    },
    {
        id: 'MUT-15',
        description: 'performReceiptTransfer : omission vérification sourceSnap.exists',
        target: 'if (!sourceSnap.exists) {',
        replacement: 'if (false && !sourceSnap.exists) {'
    }
];

let killed = 0;
let survived = 0;

console.log(`=== Lancement de la campagne de Mutation Testing sur receiptTransfer.ts (${mutants.length} mutants) ===\n`);

try {
    for (const mutant of mutants) {
        const normalizedOrig = originalCode.replace(/\r\n/g, '\n');
        if (!normalizedOrig.includes(mutant.target)) {
            throw new Error(`Cible introuvable pour ${mutant.id}: ${mutant.target}`);
        }
        const mutatedCode = normalizedOrig.replace(mutant.target, mutant.replacement);
        fs.writeFileSync(targetPath, mutatedCode, 'utf8');

        const res = spawnSync(
            process.execPath,
            ['--experimental-transform-types', '--test', testPath],
            { encoding: 'utf8' }
        );

        if (res.status !== 0) {
            killed++;
            console.log(`✅ [${mutant.id}] KILLED   — ${mutant.description}`);
        } else {
            survived++;
            console.log(`❌ [${mutant.id}] SURVIVED — ${mutant.description}`);
        }
    }
} finally {
    fs.writeFileSync(targetPath, originalCode, 'utf8');
}

const score = ((killed / mutants.length) * 100).toFixed(2);
console.log(`\n=============================================================`);
console.log(`📊 Résultat Mutation Testing WEB-03 : ${killed}/${mutants.length} mutants tués (Score : ${score}%)`);
console.log(`=============================================================`);

if (survived > 0) {
    process.exit(1);
}
