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
  { name: 'F32 sous-collections génériques ouvertes en lecture à tout connecté', file: F, find: "canReadCompta(orgId, comptaId)\n              || (sub == 'accounts' && (isComptaUploader(orgId, comptaId) || isComptaRentalManager(orgId, comptaId)))", replace: 'isAuthenticated()' },
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
  { name: 'F45 collectionGroup members fermé', file: F, find: 'allow list: if isAuthenticated() && (', replace: 'allow list: if false && (' },

  // --- SEC-02 : Anti-élévation sur /organizations, /members et /invitations ---
  { name: 'F46 création organisation ouverte à orgAdmin', file: F, find: 'allow create: if isSuperAdmin()', replace: 'allow create: if isAuthenticated()' },
  { name: 'F46b suppression organisation ouverte à orgAdmin', file: F, find: 'allow delete: if isSuperAdmin();', replace: 'allow delete: if isAuthenticated();' },
  { name: 'F47 orgAdmin peut modifier createdBy de l\'organisation', file: F, find: "&& request.resource.data.get('createdBy', null) == resource.data.get('createdBy', null)", replace: '' },
  { name: 'F48 orgAdmin peut changer adminEmail de l\'organisation', file: F, find: "request.resource.data.get('adminEmail', null) == resource.data.get('adminEmail', null)", replace: 'true' },
  { name: 'F49 orgAdmin peut changer adminUid de l\'organisation', file: F, find: "&& request.resource.data.get('adminUid', null) == resource.data.get('adminUid', null)", replace: '' },
  { name: 'F50 selfJoin accepte role != member (ex: caissier)', file: F, find: "&& normRole(data.get('role', 'member')) == 'member'", replace: '' },
  { name: 'F51 selfJoin accepte status approved', file: F, find: "&& data.get('status', '') == 'pending'", replace: '' },
  { name: 'F52 selfJoin accepte comptaAccess non vide', file: F, find: "&& comptaAccessOf(data).size() == 0", replace: '' },
  { name: 'F53 selfJoin accepte uid d\'autrui', file: F, find: "&& data.get('uid', request.auth.uid) == request.auth.uid;", replace: ';' },
  { name: 'F54 selfMemberUpdate accepte changement de status', file: F, find: "&& request.resource.data.get('status', null) == resource.data.get('status', null)", replace: '' },
  { name: 'F55 selfMemberUpdate accepte changement de uid', file: F, find: "&& request.resource.data.get('uid', null) == resource.data.get('uid', null)", replace: '' },
  { name: 'F56 invitations lisibles par tout membre connecté', file: F, find: "allow read: if isAuthenticated() && (\n          isSuperAdmin()\n          || isOrgAdmin(orgId)", replace: 'allow read: if isAuthenticated() && (\n          true\n          || isOrgAdmin(orgId)' },
  { name: 'F57 invitations créables avec statut approved', file: F, find: "&& request.resource.data.get('status', '') == 'pending'", replace: '' },
  { name: 'F58 invitations créables pour autre orgId', file: F, find: "&& request.resource.data.get('orgId', orgId) == orgId;", replace: ';' },
  { name: 'F59 invitations modifiables/supprimables par non-admin', file: F, find: 'allow update, delete: if isAuthenticated() && isOrgAdmin(orgId);', replace: 'allow update, delete: if isAuthenticated();' },
  { name: 'F60 collectionGroup invitations lisible par tous', file: F, find: 'match /{path=**}/invitations/{inviteId} {\n      allow read: if isAuthenticated() && (', replace: 'match /{path=**}/invitations/{inviteId} {\n      allow read: if isAuthenticated() || (' },
  { name: 'F61 collection mail lisible par tout connecté', file: F, find: 'match /mail/{mailId} {\n      allow read: if isSuperAdmin();', replace: 'match /mail/{mailId} {\n      allow read: if isAuthenticated();' },
  { name: 'F62 collection mail écrivable côté client', file: F, find: 'match /mail/{mailId} {\n      allow read: if isSuperAdmin();\n      allow write: if false;', replace: 'match /mail/{mailId} {\n      allow read: if isSuperAdmin();\n      allow write: if isAuthenticated();' },
  // --- SEC-05 : email_verified obligatoire ---
  { name: 'F63 firestore authEmail sans contrôle email_verified', file: F, find: "&& request.auth.token.get('email_verified', false) == true", replace: '' },
  // --- SEC-06 : verrouillage /organizations, inviteCode, /users et /members ---
  { name: 'F64 users lisible par n importe quel connecté', file: F, find: 'match /users/{userId} {\n      allow read: if isAuthenticated() && (', replace: 'match /users/{userId} {\n      allow read: if isAuthenticated() || (' },
  { name: 'F65 users create accepte isSuperAdmin true', file: F, find: "&& request.resource.data.get('isSuperAdmin', false) == false;", replace: ';' },
  { name: 'F66 users update accepte élévation isSuperAdmin', file: F, find: "&& request.resource.data.get('isSuperAdmin', false) == resource.data.get('isSuperAdmin', false);", replace: ';' },
  { name: 'F67 users delete ouvert à un autre utilisateur', file: F, find: 'allow delete: if isAuthenticated() && (isOwner(userId) || isSuperAdmin());', replace: 'allow delete: if isAuthenticated();' },
  { name: 'F68 organizations lisible anonymement', file: F, find: 'match /organizations/{orgId} {\n      allow read: if isAuthenticated();', replace: 'match /organizations/{orgId} {\n      allow read: if true;' },
  { name: 'F69 organizations create accepte inviteCode public', file: F, find: "&& !('inviteCode' in request.resource.data);", replace: ';' },
  { name: 'F70 organizations update accepte modification inviteCode public', file: F, find: "&& (!('inviteCode' in request.resource.data) || request.resource.data.get('inviteCode', null) == resource.data.get('inviteCode', null))", replace: '' },
  { name: 'F71 private invite accessible à non-admin', file: F, find: 'match /private/{docId} {\n        allow read, write: if isAuthenticated() && isOrgAdmin(orgId);', replace: 'match /private/{docId} {\n        allow read, write: if isAuthenticated();' },
  { name: 'F72 inviteCodes listable globalement', file: F, find: 'allow list: if false;', replace: 'allow list: if isAuthenticated();' },
  { name: 'F73 inviteCodes modifiable/supprimable par non-admin', file: F, find: "allow create, update: if isAuthenticated()\n        && request.resource.data.get('orgId', '') is string\n        && request.resource.data.orgId != ''\n        && isOrgAdmin(request.resource.data.orgId);", replace: 'allow create, update: if isAuthenticated();' },
  { name: 'F74 org members listable par non-membre / pending', file: F, find: 'allow list: if isAuthenticated() && isApprovedOrgMember(orgId);', replace: 'allow list: if isAuthenticated();' },
  { name: 'F75 collectionGroup members lisible pour les fiches d autrui', file: F, find: 'allow list: if isAuthenticated() && (', replace: 'allow list: if isAuthenticated() || (' },

  // --- Storage (SEC-01, SEC-03 & SEC-05) ---
  { name: 'S25 storage authEmail sans contrôle email_verified', file: S, find: "&& 'email_verified' in request.auth.token\n        && request.auth.token.email_verified == true", replace: '' },
  { name: 'S01 taille <= 5 Mo', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'request.resource.size <= 5 * 1024 * 1024' },
  { name: 'S02 taille < 6 Mo', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'request.resource.size < 6 * 1024 * 1024' },
  { name: 'S03 taille < 4 Mo', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'request.resource.size < 4 * 1024 * 1024' },
  { name: 'S04 taille max retirée', file: S, find: 'request.resource.size < 5 * 1024 * 1024', replace: 'true' },
  { name: 'S05 taille min >= 0 (fichier vide autorisé)', file: S, find: 'request.resource.size > 0', replace: 'request.resource.size >= 0' },
  { name: 'S06 taille min > 1 (1 octet refusé)', file: S, find: 'request.resource.size > 0', replace: 'request.resource.size > 1' },
  { name: 'S07 PDF refusés', file: S, find: "'image/(jpeg|jpg|png|gif|webp|heic|heif|bmp|tiff)|application/pdf'", replace: "'image/(jpeg|jpg|png|gif|webp|heic|heif|bmp|tiff)'" },
  { name: 'S08 images refusées', file: S, find: "'image/(jpeg|jpg|png|gif|webp|heic|heif|bmp|tiff)|application/pdf'", replace: "'application/pdf'" },
  { name: 'S09 tous types acceptés', file: S, find: "'image/(jpeg|jpg|png|gif|webp|heic|heif|bmp|tiff)|application/pdf'", replace: "'.*'" },
  { name: 'S10 image/svg+xml autorisé (image/.*)', file: S, find: "'image/(jpeg|jpg|png|gif|webp|heic|heif|bmp|tiff)|application/pdf'", replace: "'image/.*|application/pdf'" },
  { name: 'S11 lecture org/compta ouverte à tout connecté', file: S, find: 'allow read: if isAuthenticated() && canReadComptaReceipt(orgId, comptaId);', replace: 'allow read: if isAuthenticated();' },
  { name: 'S12 création org/compta sans validation fichier', file: S, find: '&& isValidReceiptFile()', replace: '', nth: 1 },
  { name: 'S13 création org/compta ouverte sans RBAC compta', file: S, find: '(resource == null && canCreateComptaReceipt(orgId, comptaId))', replace: 'true' },
  { name: 'S13b écrasement fichier existant ouvert à uploader', file: S, find: '(resource == null && canCreateComptaReceipt(orgId, comptaId))', replace: 'canCreateComptaReceipt(orgId, comptaId)' },
  { name: 'S14 update org/compta ouvert à uploader', file: S, find: 'allow update: if isAuthenticated() && canManageComptaReceipt(orgId, comptaId) && isValidReceiptFile();', replace: 'allow update: if isAuthenticated() && canCreateComptaReceipt(orgId, comptaId) && isValidReceiptFile();' },
  { name: 'S15 update org/compta sans validation fichier', file: S, find: 'allow update: if isAuthenticated() && canManageComptaReceipt(orgId, comptaId) && isValidReceiptFile();', replace: 'allow update: if isAuthenticated() && canManageComptaReceipt(orgId, comptaId);' },
  { name: 'S16 delete org/compta ouvert à uploader', file: S, find: 'allow delete: if isAuthenticated() && canManageComptaReceipt(orgId, comptaId);', replace: 'allow delete: if isAuthenticated() && canCreateComptaReceipt(orgId, comptaId);' },
  { name: 'S17 viewer privé de lecture Storage', file: S, find: "'verificateur', 'viewer',", replace: "'verificateur'," },
  { name: 'S18 responsable_location privé d\'upload Storage', file: S, find: "'uploader', 'responsable_location', 'location', 'locations'", replace: "'uploader'" },
  { name: 'S19 membre pending autorisé sur Storage', file: S, find: "data.get('status', 'approved') == 'approved'", replace: 'true' },
  { name: 'S20 lecture dossier personnel ouverte aux tiers', file: S, find: "(request.auth.uid == userId && userId != 'public')", replace: "(userId != 'public')", nth: 1 },
  { name: 'S21 écriture dossier personnel ouverte aux tiers', file: S, find: "((request.auth.uid == userId && userId != 'public') || isSuperAdmin())", replace: "(userId != 'public')" },
  { name: 'S22 validation fichier retirée sur dossier personnel', file: S, find: '&& isValidReceiptFile();', replace: ';', nth: 2 },
  { name: 'S23 suppression dossier personnel ouverte aux tiers', file: S, find: "(request.auth.uid == userId && userId != 'public')", replace: "(userId != 'public')", nth: 2 },
  { name: 'S24 chemin receipts/public/ revendicable par uid=public', file: S, find: " && userId != 'public'", replace: '', nth: 2 },
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
