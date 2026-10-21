import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rbacPath = path.resolve(import.meta.dirname, '../rbac.ts');
const testPath = path.resolve(import.meta.dirname, './rbac.web01.test.mjs');
const originalCode = fs.readFileSync(rbacPath, 'utf8');

/**
 * Liste exhaustive de mutants (opérateurs, conditions limites, retours booléens, chaînes, normalisation)
 * appliqués sur frontend/types/rbac.ts pour vérifier que la suite de tests tue 100 % des mutants.
 */
const mutants = [
    {
        id: 'MUT-01',
        description: "Modification de la valeur d'enum UPLOADER ('uploader' -> 'viewer')",
        target: "UPLOADER = 'uploader'",
        replacement: "UPLOADER = 'viewer'"
    },
    {
        id: 'MUT-02',
        description: 'Suppression du .trim() dans normalizeRoleInput',
        target: 'return role.trim().toLowerCase();',
        replacement: 'return role.toLowerCase();'
    },
    {
        id: 'MUT-03',
        description: 'Suppression du .toLowerCase() dans normalizeRoleInput',
        target: 'return role.trim().toLowerCase();',
        replacement: 'return role.trim();'
    },
    {
        id: 'MUT-04',
        description: "Inversion du check typeof role !== 'string' dans normalizeRoleInput",
        target: "if (typeof role !== 'string') return '';",
        replacement: "if (typeof role === 'string') return '';"
    },
    {
        id: 'MUT-05',
        description: 'Inversion logique dans isUploaderRole (=== -> !==)',
        target: 'return norm === ComptaRole.UPLOADER;',
        replacement: 'return norm !== ComptaRole.UPLOADER;'
    },
    {
        id: 'MUT-06',
        description: 'Remplacement de || par && dans isCaissierRole',
        target: "return norm === ComptaRole.CAISSIER || norm === ComptaRole.COMPTABLE || norm === 'admin';",
        replacement: "return norm === ComptaRole.CAISSIER && norm === ComptaRole.COMPTABLE || norm === 'admin';"
    },
    {
        id: 'MUT-07',
        description: 'Inversion logique dans isVerificateurRole (=== -> !==)',
        target: 'return norm === ComptaRole.VERIFICATEUR;',
        replacement: 'return norm !== ComptaRole.VERIFICATEUR;'
    },
    {
        id: 'MUT-08',
        description: 'Inversion logique dans isViewerRole (=== -> !==)',
        target: 'return norm === ComptaRole.VIEWER;',
        replacement: 'return norm !== ComptaRole.VIEWER;'
    },
    {
        id: 'MUT-09',
        description: 'Omission de ComptaRole.UPLOADER dans isValidComptaRole',
        target: '        norm === ComptaRole.VIEWER ||\n        norm === ComptaRole.UPLOADER',
        replacement: '        norm === ComptaRole.VIEWER'
    },
    {
        id: 'MUT-10',
        description: 'Autorisation erronée de uploader dans canOpenComptaOnWeb',
        target: '    return isCaissierRole(norm) || isVerificateurRole(norm) || isViewerRole(norm);',
        replacement: '    return isCaissierRole(norm) || isVerificateurRole(norm) || isViewerRole(norm) || isUploaderRole(norm);'
    },
    {
        id: 'MUT-11',
        description: 'Ignorer le flag isOrgAdmin dans canOpenComptaOnWeb',
        target: '    if (isSuperAdmin === true || isOrgAdmin === true) return true;',
        replacement: '    if (isSuperAdmin === true) return true;'
    },
    {
        id: 'MUT-12',
        description: 'Ignorer le flag isSuperAdmin dans canOpenComptaOnWeb',
        target: '    if (isSuperAdmin === true || isOrgAdmin === true) return true;',
        replacement: '    if (isOrgAdmin === true) return true;'
    },
    {
        id: 'MUT-13',
        description: 'Comparaison laxiste de isOrgAdmin dans canOpenComptaOnWeb',
        target: '    if (isSuperAdmin === true || isOrgAdmin === true) return true;',
        replacement: '    if (isSuperAdmin || isOrgAdmin) return true;'
    },
    {
        id: 'MUT-14',
        description: 'Omission de la garde isArchived dans canUploadReceiptToCompta',
        target: '    if (isArchived === true) return false;',
        replacement: '    if (false) return false;'
    },
    {
        id: 'MUT-15',
        description: 'Refus erroné de uploader dans canUploadReceiptToCompta',
        target: '    return isUploaderRole(norm) || isCaissierRole(norm);',
        replacement: '    return isCaissierRole(norm);'
    },
    {
        id: 'MUT-16',
        description: 'Autorisation erronée de viewer dans canUploadReceiptToCompta',
        target: '    return isUploaderRole(norm) || isCaissierRole(norm);',
        replacement: '    return isUploaderRole(norm) || isCaissierRole(norm) || isViewerRole(norm);'
    },
    {
        id: 'MUT-17',
        description: "Libellé incorrect pour uploader dans getComptaRoleLabel ('Déposant Factures' -> 'Lecteur')",
        target: "    if (isUploaderRole(norm)) return 'Déposant Factures';",
        replacement: "    if (isUploaderRole(norm)) return 'Lecteur';"
    },
    {
        id: 'MUT-18',
        description: "Libellé par défaut incorrect dans getComptaRoleLabel ('Aucun accès' -> '')",
        target: "    return 'Aucun accès';",
        replacement: "    return '';"
    },
    {
        id: 'MUT-19',
        description: 'Suppression du .trim() sur comptaId dans applyComptaRoleChange',
        target: "    const cleanComptaId = typeof comptaId === 'string' ? comptaId.trim() : '';",
        replacement: "    const cleanComptaId = typeof comptaId === 'string' ? comptaId : '';"
    },
    {
        id: 'MUT-20',
        description: "Omission du delete lors de la révocation ('none') dans applyComptaRoleChange",
        target: '        delete nextAccess[cleanComptaId];\n        return nextAccess;',
        replacement: '        return nextAccess;'
    },
    {
        id: 'MUT-21',
        description: 'Suppression de la validation isValidComptaRole dans applyComptaRoleChange',
        target: '    if (!isValidComptaRole(normRole)) {\n        throw new Error(`Rôle de comptabilité invalide: ${String(newRole)}`);\n    }',
        replacement: '    if (false) {\n        throw new Error(`Rôle de comptabilité invalide: ${String(newRole)}`);\n    }'
    },
    {
        id: 'MUT-22',
        description: 'Mutation directe de currentAccess (perte immutabilité) dans applyComptaRoleChange',
        target: '    const nextAccess: Record<string, ComptaRole> = { ...(currentAccess || {}) };',
        replacement: '    const nextAccess: Record<string, ComptaRole> = currentAccess || {};'
    }
];

let killed = 0;
let survived = 0;
const results = [];

console.log(`=== Lancement de la campagne de Mutation Testing sur frontend/types/rbac.ts (${mutants.length} mutants) ===\n`);

try {
    for (const mutant of mutants) {
        const normalizedOrig = originalCode.replace(/\r\n/g, '\n');
        if (!normalizedOrig.includes(mutant.target)) {
            throw new Error(`Cible introuvable pour ${mutant.id}: ${mutant.target}`);
        }
        const mutatedCode = normalizedOrig.replace(mutant.target, mutant.replacement);
        fs.writeFileSync(rbacPath, mutatedCode, 'utf8');

        const res = spawnSync(
            process.execPath,
            ['--experimental-transform-types', '--test', testPath],
            { encoding: 'utf8' }
        );

        if (res.status !== 0) {
            killed++;
            results.push({ id: mutant.id, status: 'KILLED', description: mutant.description });
            console.log(`✅ [${mutant.id}] KILLED   — ${mutant.description}`);
        } else {
            survived++;
            results.push({ id: mutant.id, status: 'SURVIVED', description: mutant.description });
            console.log(`❌ [${mutant.id}] SURVIVED — ${mutant.description}`);
        }
    }
} finally {
    // Toujours restaurer le fichier source original intact
    fs.writeFileSync(rbacPath, originalCode, 'utf8');
}

const score = ((killed / mutants.length) * 100).toFixed(2);
console.log(`\n=============================================================`);
console.log(`📊 Résultat Mutation Testing : ${killed}/${mutants.length} mutants tués (Score : ${score}%)`);
console.log(`=============================================================`);

if (survived > 0) {
    process.exit(1);
}
