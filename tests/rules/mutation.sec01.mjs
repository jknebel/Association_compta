/**
 * SEC-01 — Test de mutation des règles Firebase (firestore.rules & storage.rules).
 *
 * Chaque mutant altère une règle de sécurité ; la suite de tests
 * (tests/rules/sec01.rules.test.mjs) doit échouer pour "tuer" le mutant.
 *
 * Exécution (depuis la racine du dépôt, Java requis pour les émulateurs) :
 *   node tests/rules/mutation.sec01.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SEC01_RULES_ROOT || path.resolve(__dirname, '../..');
const original = {
  'firestore.rules': fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'),
  'storage.rules': fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8'),
};

/** Remplace la n-ième occurrence (1-based) de `find` par `replace`. */
function replaceNth(src, find, replace, nth = 1) {
  let idx = -1;
  for (let i = 0; i < nth; i++) {
    idx = src.indexOf(find, idx + 1);
    if (idx === -1) return src;
  }
  return src.slice(0, idx) + replace + src.slice(idx + find.length);
}

const F = 'firestore.rules';
const S = 'storage.rules';
const UPL = '!isUploaderOnly(orgId, comptaId)';

const mutants = [
  // --- Détection du rôle uploader ---
  { name: 'F01 ignore le rôle de la sous-collection members', file: F, find: "comptaSubRole(orgId, comptaId) == 'uploader'", replace: 'false' },
  { name: 'F02 ignore comptaAccess (fiche par uid)', file: F, find: "orgMemberAccessRole(orgMemberPathByUid(orgId), comptaId) == 'uploader'", replace: 'false' },
  { name: 'F03 ignore comptaAccess (fiche par e-mail)', file: F, find: "orgMemberAccessRole(orgMemberPathByEmail(orgId), comptaId) == 'uploader'", replace: 'false' },
  { name: 'F04 admin d\'organisation restreint', file: F, find: '\n        && !isOrgAdmin(orgId);', replace: ';' },
  { name: 'F05 super-admin restreint', file: F, find: "request.auth.token.get('superAdmin', false) != true", replace: 'true' },
  { name: 'F06 admin détecté seulement par uid (jamais)', file: F, find: "orgMemberOrgRole(orgMemberPathByUid(orgId)) == 'admin'", replace: 'false' },
  { name: 'F07 admin détecté par e-mail (jamais)', file: F, find: "orgMemberOrgRole(orgMemberPathByEmail(orgId)) == 'admin'", replace: 'false' },
  { name: 'F08 e-mail non normalisé en minuscules', file: F, find: 'request.auth.token.email.lower()', replace: 'request.auth.token.email' },
  { name: 'F09 rôle non nettoyé (trim)', file: F, find: 'value.trim().lower()', replace: 'value.lower()' },
  { name: 'F10 rôle sensible à la casse (lower)', file: F, find: 'value.trim().lower()', replace: 'value.trim()' },
  { name: 'F11 e-mail ignoré dans hasUploaderRole', file: F, find: "(authEmail() != '' && orgMemberAccessRole(", replace: "(false && orgMemberAccessRole(" },

  // --- Création de justificatifs par un uploader ---
  { name: 'F12 submittedByUid non vérifié', file: F, find: "data.get('submittedByUid', '') == request.auth.uid", replace: 'true' },
  { name: 'F13 reimbursedAt autorisé', file: F, find: "'reimbursedAt', ", replace: '' },
  { name: 'F14 reimbursedByUid autorisé', file: F, find: "'reimbursedByUid', ", replace: '' },
  { name: 'F15 reimbursedByName autorisé', file: F, find: "'reimbursedByName', ", replace: '' },
  { name: 'F16 transferRequest autorisé', file: F, find: "'transferRequest', ", replace: '' },
  { name: 'F17 transferHistory autorisé', file: F, find: ", 'transferHistory'", replace: '' },
  { name: 'F18 statut REIMBURSED autorisé', file: F, find: "in ['PENDING', null]", replace: "in ['PENDING', 'REIMBURSED', null]" },
  { name: 'F19 statut null refusé', file: F, find: "in ['PENDING', null]", replace: "in ['PENDING']" },
  { name: 'F20 linkedTransactionId non vérifié', file: F, find: "data.get('linkedTransactionId', null) == null", replace: 'true' },
  { name: 'F21 création de justificatif libre pour uploader', file: F, find: `${UPL} || isValidUploaderReceipt()`, replace: 'true' },
  { name: 'F22 création refusée aux non-uploaders', file: F, find: `${UPL} || isValidUploaderReceipt()`, replace: 'isValidUploaderReceipt()' },

  // --- Lecture / modification des justificatifs ---
  { name: 'F23 lecture des justificatifs des autres', file: F, find: "resource.data.get('submittedByUid', '') == request.auth.uid\n          );", replace: 'true\n          );' },
  { name: 'F24 lecture refusée aux non-uploaders', file: F, find: `            ${UPL} ||\n            resource.data`, replace: '            resource.data' },
  { name: 'F25 modif/suppression justificatifs ouverte aux uploaders', file: F, find: `allow update, delete: if isAuthenticated() && ${UPL};`, replace: 'allow update, delete: if isAuthenticated();', nth: 2 },
  { name: 'F26 modif/suppression justificatifs fermée à tous', file: F, find: `allow update, delete: if isAuthenticated() && ${UPL};`, replace: 'allow update, delete: if false;', nth: 2 },

  // --- Écritures comptables, comptes, paramètres ---
  { name: 'F27 écritures/comptes ouverts aux uploaders', file: F, find: `\n            && ${UPL};`, replace: ';' },
  { name: 'F28 sous-collection receipts écrasée par la règle générique', file: F, find: "            && sub != 'receipts'\n            && sub != 'members'", replace: "            && sub != 'members'" },
  { name: 'F29 sous-collection members écrasée par la règle générique', file: F, find: "            && sub != 'members'", replace: '' },
  { name: 'F30 lecture générique inclut receipts', file: F, find: "allow read: if isAuthenticated() && sub != 'receipts';", replace: 'allow read: if isAuthenticated();' },
  { name: 'F31 lecture générique fermée', file: F, find: "allow read: if isAuthenticated() && sub != 'receipts';", replace: 'allow read: if false;' },
  { name: 'F32 document comptabilité modifiable par uploader', file: F, find: `allow update, delete: if isAuthenticated() && ${UPL};`, replace: 'allow update, delete: if isAuthenticated();', nth: 1 },
  { name: 'F33 création de comptabilité refusée', file: F, find: 'allow read, create: if isAuthenticated();\n        allow update, delete: if isAuthenticated() &&', replace: 'allow read: if isAuthenticated();\n        allow update, delete: if isAuthenticated() &&' },

  // --- Anti-élévation de privilèges ---
  { name: 'F34 membres de la compta modifiables par uploader', file: F, find: `allow write: if isAuthenticated() && ${UPL};`, replace: 'allow write: if isAuthenticated();' },
  { name: 'F35 membres de la compta fermés à tous', file: F, find: `allow write: if isAuthenticated() && ${UPL};`, replace: 'allow write: if false;' },
  { name: 'F36 auto-modification de fiche org autorisée', file: F, find: 'allow update, delete: if isAuthenticated() && !isRestrictedSelfMember(memberId);', replace: 'allow update, delete: if isAuthenticated();' },
  { name: 'F37 modification de fiche org fermée à tous', file: F, find: 'allow update, delete: if isAuthenticated() && !isRestrictedSelfMember(memberId);', replace: 'allow update, delete: if false;' },
  { name: 'F38 fiche par uid non protégée', file: F, find: '(memberId == request.auth.uid || ', replace: '(false || ' },
  { name: 'F39 fiche par e-mail non protégée', file: F, find: "(authEmail() != '' && memberId == authEmail())", replace: 'false' },
  { name: 'F40 admin-uploader bloqué sur sa fiche', file: F, find: "resource.data.get('role', '') != 'admin'", replace: 'true' },
  { name: 'F41 contrôle comptaAccess uploader neutralisé', file: F, find: ".values().hasAny(['uploader'])", replace: ".values().hasAny(['zzz'])" },
  { name: 'F42 création de fiche membre refusée', file: F, find: 'allow read, create: if isAuthenticated();\n        allow update, delete: if isAuthenticated() && !isRestrictedSelfMember', replace: 'allow read: if isAuthenticated();\n        allow update, delete: if isAuthenticated() && !isRestrictedSelfMember' },

  // --- Comportement historique conservé ---
  { name: 'F43 écriture du document org fermée', file: F, find: 'allow write: if isAuthenticated();\n\n      match /members', replace: 'allow write: if false;\n\n      match /members' },
  { name: 'F44 lecture du document org réservée aux connectés', file: F, find: 'allow read: if true;', replace: 'allow read: if isAuthenticated();' },
  { name: 'F45 invitations fermées', file: F, find: 'allow read, write: if isAuthenticated();\n      }\n\n      match /comptabilites', replace: 'allow read: if isAuthenticated();\n      }\n\n      match /comptabilites' },
  { name: 'F46 collectionGroup members fermé', file: F, find: 'match /{path=**}/members/{memberId} {\n      allow read: if isAuthenticated();', replace: 'match /{path=**}/members/{memberId} {\n      allow read: if false;' },
  { name: 'F47 lecture des justificatifs ouverte aux anonymes', file: F, find: 'allow read: if isAuthenticated() && (\n            !isUploaderOnly', replace: 'allow read: if (\n            !isUploaderOnly' },
  { name: 'F48 lecture membres compta ouverte aux anonymes', file: F, find: 'allow read: if isAuthenticated();\n          allow write: if isAuthenticated() && !isUploaderOnly', replace: 'allow read: if true;\n          allow write: if isAuthenticated() && !isUploaderOnly' },

  // --- Storage ---
  { name: 'S01 taille <= 5 Mo', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'request.resource.size <= 5 * 1024 * 1024' },
  { name: 'S02 taille < 6 Mo', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'request.resource.size < 6 * 1024 * 1024' },
  { name: 'S03 taille < 4 Mo', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'request.resource.size < 4 * 1024 * 1024' },
  { name: 'S04 taille non limitée', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'true' },
  { name: 'S05 PDF refusés', file: S, find: "'image/.*|application/pdf'", replace: "'image/.*'" },
  { name: 'S06 images refusées', file: S, find: "'image/.*|application/pdf'", replace: "'application/pdf'" },
  { name: 'S07 tous types acceptés', file: S, find: "'image/.*|application/pdf'", replace: "'.*'" },
  { name: 'S08 tous types application/*', file: S, find: "'image/.*|application/pdf'", replace: "'image/.*|application/.*'" },
  { name: 'S09 type contenant image accepté', file: S, find: "'image/.*|application/pdf'", replace: "'.*image/.*|.*application/pdf'" },
  { name: 'S10 contentType non requis', file: S, find: '        && request.resource.contentType != null\n', replace: '' },
  { name: 'S11 contraintes retirées (chemin org/compta, create/update)', file: S, find: 'allow create, update: if request.auth != null && isValidReceiptFile();', replace: 'allow create, update: if request.auth != null;', nth: 1 },
  { name: 'S12 contraintes retirées (anciens chemins, create/update)', file: S, find: 'allow create, update: if request.auth != null && isValidReceiptFile();', replace: 'allow create, update: if request.auth != null;', nth: 2 },
  { name: 'S13 écriture anonyme (chemin org/compta)', file: S, find: 'allow create, update: if request.auth != null && isValidReceiptFile();', replace: 'allow create, update: if isValidReceiptFile();', nth: 1 },
  { name: 'S14 écriture anonyme (anciens chemins)', file: S, find: 'allow create, update: if request.auth != null && isValidReceiptFile();', replace: 'allow create, update: if isValidReceiptFile();', nth: 2 },
  { name: 'S15 lecture anonyme (chemin org/compta)', file: S, find: 'allow read: if request.auth != null;', replace: 'allow read: if true;', nth: 1 },
  { name: 'S16 suppression anonyme (chemin org/compta)', file: S, find: 'allow delete: if request.auth != null;', replace: 'allow delete: if true;', nth: 1 },
  { name: 'S17 suppression interdite (anciens chemins)', file: S, find: 'allow delete: if request.auth != null;', replace: 'allow delete: if false;', nth: 2 },
  { name: 'S18 anciens chemins fermés', file: S, find: 'match /receipts/{allPaths=**} {', replace: 'match /receiptsXX/{allPaths=**} {' },
];

function runSuite(rulesRoot) {
  const cmd = 'firebase emulators:exec --only firestore,storage --project demo-sec01 "node --test tests/rules/sec01.rules.test.mjs"';
  const res = spawnSync(cmd, {
    shell: true,
    cwd: process.env.SEC01_PROJECT_DIR || ROOT,
    env: { ...process.env, SEC01_RULES_ROOT: rulesRoot },
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  return { status: res.status, out };
}

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const selected = mutants.filter((m) => !only || only.test(m.name));
console.log(`Test de mutation SEC-01 : ${selected.length} mutants à évaluer...`);

let killed = 0;
const survivors = [];
const invalid = [];

for (const m of selected) {
  const mutated = replaceNth(original[m.file], m.find, m.replace, m.nth || 1);
  if (mutated === original[m.file]) {
    invalid.push(`${m.name} (mutation non appliquée)`);
    console.error(`⚠️  Non appliqué : ${m.name}`);
    continue;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec01-mut-'));
  for (const f of Object.keys(original)) fs.writeFileSync(path.join(tmp, f), f === m.file ? mutated : original[f], 'utf8');

  const { status, out } = runSuite(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });

  if (/Error compiling rules/i.test(out)) {
    invalid.push(`${m.name} (règles invalides)`);
    console.error(`⚠️  Règles invalides : ${m.name}`);
  } else if (status !== 0) {
    killed++;
    console.log(`✅ Tué     : ${m.name}`);
  } else {
    survivors.push(m.name);
    console.error(`🚨 SURVIVANT : ${m.name}`);
  }
}

const valid = killed + survivors.length;
const score = valid === 0 ? 0 : Math.round((killed / valid) * 100);
console.log('\n========================================');
console.log(`SEC-01 Mutation Score : ${score}% (${killed}/${valid} mutants tués)`);
if (invalid.length) console.log(`Mutants invalides : ${invalid.length}\n - ${invalid.join('\n - ')}`);
if (survivors.length) console.log(`Survivants :\n - ${survivors.join('\n - ')}`);
console.log('========================================\n');

process.exit(survivors.length > 0 || invalid.length > 0 ? 1 : 0);
