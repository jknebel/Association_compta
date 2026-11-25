/**
 * SEC-01 — Test de mutation des règles Firebase (firestore.rules & storage.rules).
 *
 * Chaque mutant altère une règle de sécurité ; la suite de tests
 * (tests/rules/sec01.rules.test.mjs) doit échouer pour "tuer" le mutant.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SEC01_RULES_ROOT || path.resolve(__dirname, '../..');
const original = {
  'firestore.rules': fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n'),
  'storage.rules': fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8').replace(/\r\n/g, '\n'),
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

const mutants = [
  // --- Détection des rôles & statuts approuvés ---
  { name: 'F01 ignore le rôle de la sous-collection members', file: F, find: "comptaSubRole(orgId, comptaId) in allowedRoles", replace: 'false' },
  { name: 'F02 ignore comptaAccess (fiche par uid)', file: F, find: "orgMemberAccessRole(orgMemberPathByUid(orgId), comptaId) in allowedRoles", replace: 'false' },
  { name: 'F03 ignore comptaAccess (fiche par e-mail)', file: F, find: "orgMemberAccessRole(orgMemberPathByEmail(orgId), comptaId) in allowedRoles", replace: 'false' },
  { name: 'F04 ignore le contrôle status == approved sur comptaAccess', file: F, find: 'exists(path) && isApprovedMemberDoc(get(path).data)', replace: 'exists(path)', nth: 1 },
  { name: 'F05 ignore le contrôle status == approved sur orgRole', file: F, find: 'exists(path) && isApprovedMemberDoc(get(path).data)', replace: 'exists(path)', nth: 2 },
  { name: 'F06 isApprovedMemberDoc accepte pending/rejected', file: F, find: "data.get('status', 'approved') == 'approved'", replace: 'true' },
  { name: 'F07 admin détecté seulement par uid (jamais)', file: F, find: "orgMemberOrgRole(orgMemberPathByUid(orgId)) == 'admin'", replace: 'false' },
  { name: 'F08 e-mail non normalisé en minuscules', file: F, find: 'request.auth.token.email.lower()', replace: 'request.auth.token.email' },
  { name: 'F09 rôle non nettoyé (trim)', file: F, find: 'value.trim().lower()', replace: 'value.lower()' },
  { name: 'F10 rôle sensible à la casse (lower)', file: F, find: 'value.trim().lower()', replace: 'value.trim()' },
  { name: 'F11 cas historique sans role sur compta/members cassé', file: F, find: "'role' in get(path).data ? normRole(get(path).data.role) : 'comptable'", replace: "normRole(get(path).data.get('role', ''))" },
  { name: 'F12 super-admin ignoré', file: F, find: "request.auth.token.get('superAdmin', false) == true", replace: 'false' },

  // --- Création / lecture / modification des justificatifs ---
  { name: 'F13 submittedByUid non vérifié', file: F, find: "data.get('submittedByUid', '') == request.auth.uid", replace: 'true' },
  { name: 'F14 reimbursedAt autorisé', file: F, find: "'reimbursedAt', ", replace: '' },
  { name: 'F15 reimbursedByUid autorisé', file: F, find: "'reimbursedByUid', ", replace: '' },
  { name: 'F16 reimbursedByName autorisé', file: F, find: "'reimbursedByName', ", replace: '' },
  { name: 'F17 transferRequest autorisé', file: F, find: "'transferRequest', ", replace: '' },
  { name: 'F18 transferHistory autorisé', file: F, find: ", 'transferHistory'", replace: '' },
  { name: 'F19 statut REIMBURSED autorisé pour uploader', file: F, find: "in ['PENDING', null]", replace: "in ['PENDING', 'REIMBURSED', null]" },
  { name: 'F20 statut null refusé pour uploader', file: F, find: "in ['PENDING', null]", replace: "in ['PENDING']" },
  { name: 'F21 linkedTransactionId non vérifié', file: F, find: "data.get('linkedTransactionId', null) == null", replace: 'true' },
  { name: 'F22 lecture des justificatifs ouverte à tous les connectés', file: F, find: "allow read: if canReadCompta(orgId, comptaId)", replace: "allow read: if isAuthenticated()" },
  { name: 'F23 lecture reçus d\'autrui autorisée pour uploader', file: F, find: "resource.data.get('submittedByUid', '') == request.auth.uid", replace: 'true' },
  { name: 'F24 vérificateur peut modifier n\'importe quel champ de reçu', file: F, find: "affectedKeys().hasOnly(['linkedTransactionId'])", replace: 'true' },
  { name: 'F25 suppression justificatifs ouverte aux non-caissiers', file: F, find: "allow delete: if isComptaAccountingWriter(orgId, comptaId);", replace: 'allow delete: if isAuthenticated();', nth: 2 },

  // --- Isolation inter-comptabilités & moindre privilège (transactions / sous-collections / rentals) ---
  { name: 'F26 transactions lisibles par tout membre connecté', file: F, find: "allow read: if canReadCompta(orgId, comptaId);", replace: 'allow read: if isAuthenticated();' },
  { name: 'F27 transactions créables/supprimables par viewer/verificateur', file: F, find: "allow create, delete: if isComptaAccountingWriter(orgId, comptaId);", replace: 'allow create, delete: if canReadCompta(orgId, comptaId);' },
  { name: 'F28 vérificateur peut modifier montant ou date', file: F, find: "!request.resource.data.diff(resource.data).affectedKeys().hasAny(['amount', 'date', 'id', 'runningBalance'])", replace: 'true' },
  { name: 'F29 vérificateur bloqué sur les propositions', file: F, find: "isComptaVerificateur(orgId, comptaId)", replace: 'false', nth: 2 },
  { name: 'F30 viewer peut modifier le statut d\'une transaction', file: F, find: "affectedKeys().hasOnly(['comments'])", replace: 'true' },
  { name: 'F31 viewer bloqué pour commenter une transaction', file: F, find: "isComptaViewer(orgId, comptaId)", replace: 'false', nth: 2 },
  { name: 'F32 sous-collection générique écrase transactions', file: F, find: "&& sub != 'transactions'\n", replace: '', nth: 1 },
  { name: 'F33 sous-collection générique écrase members en écriture', file: F, find: "&& sub != 'members'\n", replace: '', nth: 2 },
  { name: 'F34 lecture accounts refusée à uploader', file: F, find: "sub == 'accounts' && (isComptaUploader(orgId, comptaId) || isComptaRentalManager(orgId, comptaId))", replace: 'false' },
  { name: 'F35 création de comptabilité ouverte à tout connecté', file: F, find: "allow create: if isAuthenticated()\n          && isOrgCaissier(orgId)\n          && request.resource.data.get('createdBy', '') == request.auth.uid;", replace: 'allow create: if isAuthenticated();' },
  { name: 'F35b création de comptabilité accepte createdBy forgé', file: F, find: "&& request.resource.data.get('createdBy', '') == request.auth.uid;", replace: '' },
  { name: 'F36 création de comptabilité fermée', file: F, find: "allow create: if isAuthenticated()\n          && isOrgCaissier(orgId)\n          && request.resource.data.get('createdBy', '') == request.auth.uid;", replace: 'allow create: if false;' },
  { name: 'F37 document comptabilité modifiable par non-caissier', file: F, find: "allow update, delete: if isComptaAccountingWriter(orgId, comptaId);", replace: 'allow update, delete: if isAuthenticated();' },
  { name: 'F38 rentals ouverts à tout connecté', file: F, find: "allow write: if isComptaAccountingWriter(orgId, comptaId) || isComptaRentalManager(orgId, comptaId);", replace: 'allow write: if isAuthenticated();' },
  { name: 'F39 responsable_location bloqué sur notifications', file: F, find: "sub == 'notifications' && isComptaRentalManager(orgId, comptaId)", replace: 'false' },

  // --- Anti-élévation de privilèges ---
  { name: 'F40 membres de la compta acceptent le rôle admin par caissier (create)', file: F, find: "'caissier', 'comptable', 'verificateur', 'viewer', 'uploader', 'responsable_location', 'location'", replace: "'admin', 'caissier', 'comptable', 'verificateur', 'viewer', 'uploader', 'responsable_location', 'location'", nth: 1 },
  { name: 'F40b membres de la compta acceptent le rôle admin par caissier (update)', file: F, find: "'caissier', 'comptable', 'verificateur', 'viewer', 'uploader', 'responsable_location', 'location'", replace: "'admin', 'caissier', 'comptable', 'verificateur', 'viewer', 'uploader', 'responsable_location', 'location'", nth: 2 },
  { name: 'F41 membres de la compta modifiables par uploader/viewer', file: F, find: "isComptaAccountingWriter(orgId, comptaId)\n            || (\n              isOrgCaissier(orgId)\n              && request.auth.uid == memberUid\n              && get(/databases/$(database)/documents/organizations/$(orgId)/comptabilites/$(comptaId)).data.get('createdBy', '') == request.auth.uid\n            )", replace: 'isAuthenticated()' },
  { name: 'F41b caissier c1 peut s\'auto-ajouter sur c2 sans être créateur', file: F, find: "&& get(/databases/$(database)/documents/organizations/$(orgId)/comptabilites/$(comptaId)).data.get('createdBy', '') == request.auth.uid", replace: '' },
  { name: 'F42 auto-modification de fiche org ouverte à uploader', file: F, find: "allow update: if isAuthenticated() && (\n          isOrgAdmin(orgId)\n          || isSafeSelfMemberUpdate(memberId)\n        );", replace: 'allow update: if isAuthenticated();' },
  { name: 'F43 contrôle comptaAccess uploader neutralisé', file: F, find: ".values().hasAny(['uploader'])", replace: ".values().hasAny(['zzz'])" },
  { name: 'F44 admin-uploader bloqué sur sa fiche', file: F, find: "resource.data.get('role', '') != 'admin'", replace: 'true' },
  { name: 'F45 collectionGroup members fermé', file: F, find: 'match /{path=**}/members/{memberId} {\n      allow read: if isAuthenticated();', replace: 'match /{path=**}/members/{memberId} {\n      allow read: if false;' },

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
  { name: 'S10 contentType non requis', file: S, find: "&& request.resource.contentType != null", replace: '&& true' },
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
  const emulatorRunning = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST);
  const cmd = emulatorRunning
    ? 'node --test tests/rules/sec01.rules.test.mjs'
    : 'firebase emulators:exec --only firestore,storage --project demo-sec01 "node --test tests/rules/sec01.rules.test.mjs"';
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
