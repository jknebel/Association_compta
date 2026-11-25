/**
 * SEC-01 — Tests des règles de sécurité Firebase (firestore.rules & storage.rules)
 * pour le rôle "uploader" (Déposant de factures, App Mobile).
 *
 * Exécution (émulateurs Firebase requis, donc Java) :
 *   firebase emulators:exec --only firestore,storage --project demo-sec01 "node --test tests/rules/sec01.rules.test.mjs"
 * ou via : npm run test:rules
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SEC01_RULES_ROOT || path.resolve(__dirname, '../..');
const firestoreRules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const storageRules = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8');

const ORG = 'o1';
const C1 = `organizations/${ORG}/comptabilites/c1`;
const C2 = `organizations/${ORG}/comptabilites/c2`;
const MB = 1024 * 1024;

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-sec01',
    firestore: { rules: firestoreRules },
    storage: { rules: storageRules },
  });
});

after(async () => {
  await testEnv.cleanup();
});

async function seed() {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`organizations/${ORG}`).set({ name: 'Asso Test' });

    // Membres de l'organisation
    await db.doc(`organizations/${ORG}/members/orgadmin`).set({ role: 'admin', status: 'approved' });
    await db.doc(`organizations/${ORG}/members/upl1`).set({ role: 'member', status: 'approved', comptaAccess: { c1: 'uploader' } });
    await db.doc(`organizations/${ORG}/members/upl2`).set({ role: 'member', status: 'approved', comptaAccess: { c1: 'uploader', c2: 'caissier' } });
    await db.doc(`organizations/${ORG}/members/cais1`).set({ role: 'member', status: 'approved', comptaAccess: { c1: 'caissier' } });
    await db.doc(`organizations/${ORG}/members/verif1`).set({ role: 'member', status: 'approved', comptaAccess: { c1: 'verificateur' } });
    await db.doc(`organizations/${ORG}/members/viewer1`).set({ role: 'member', status: 'approved', comptaAccess: { c1: 'viewer' } });
    await db.doc(`organizations/${ORG}/members/adminupl`).set({ role: 'admin', status: 'approved', comptaAccess: { c1: 'uploader' } });
    await db.doc(`organizations/${ORG}/members/legacy@x.ch`).set({ role: 'member', status: 'approved', email: 'legacy@x.ch', comptaAccess: { c1: 'uploader' } });
    await db.doc(`organizations/${ORG}/members/upl3`).set({ role: 'member', status: 'approved', comptaAccess: { c1: ' Uploader ' } });

    // Comptabilités c1 & c2
    for (const c of [C1, C2]) {
      await db.doc(c).set({ name: c.endsWith('c1') ? 'Compta 1' : 'Compta 2', createdBy: 'orgadmin' });
      await db.doc(`${c}/accounts/a1`).set({ code: '1000', name: 'Caisse' });
      await db.doc(`${c}/transactions/t1`).set({ amount: 10, description: 'Test' });
      await db.doc(`${c}/settings/aiConfig`).set({ context: 'ctx' });
      await db.doc(`${c}/categories/cat1`).set({ name: 'Cat' });
    }

    // Rôles directs (sous-collection members)
    await db.doc(`${C1}/members/upl1`).set({ uid: 'upl1', role: 'uploader' });
    await db.doc(`${C1}/members/upl2`).set({ uid: 'upl2', role: 'uploader' });
    await db.doc(`${C2}/members/upl2`).set({ uid: 'upl2', role: 'caissier' });
    await db.doc(`${C1}/members/cais1`).set({ uid: 'cais1', role: 'caissier' });
    await db.doc(`${C1}/members/verif1`).set({ uid: 'verif1', role: 'verificateur' });
    await db.doc(`${C1}/members/viewer1`).set({ uid: 'viewer1', role: 'viewer' });
    await db.doc(`${C1}/members/adminupl`).set({ uid: 'adminupl', role: 'uploader' });
    await db.doc(`${C1}/members/sa1`).set({ uid: 'sa1', role: 'uploader' });

    // Justificatifs existants
    await db.doc(`${C1}/receipts/r-upl1`).set({ fileName: 'a.jpg', submittedByUid: 'upl1' });
    await db.doc(`${C1}/receipts/r-cais1`).set({ fileName: 'b.jpg', submittedByUid: 'cais1' });
    await db.doc(`${C1}/receipts/r-legacy`).set({ fileName: 'c.jpg' });
    await db.doc(`${C2}/receipts/r-c2`).set({ fileName: 'c2.jpg', submittedByUid: 'upl2' });
    await db.doc(`${C1}/rentals/rent1`).set({ renterName: 'Loc', amount: 100 });
    await db.doc(`${C2}/rentals/rent2`).set({ renterName: 'Loc2', amount: 200 });

    // Membres avec statuts non approuvés / rôles additionnels / utilisateur sans rôle
    await db.doc(`organizations/${ORG}/members/pending1`).set({ role: 'member', status: 'pending', comptaAccess: { c1: 'caissier' } });
    await db.doc(`organizations/${ORG}/members/orgpending`).set({ role: 'admin', status: 'pending' });
    await db.doc(`organizations/${ORG}/members/rejected1`).set({ role: 'member', status: 'rejected', comptaAccess: { c1: 'caissier' } });
    await db.doc(`organizations/${ORG}/members/loc1`).set({ role: 'member', status: 'approved', comptaAccess: { c1: 'responsable_location' } });
    await db.doc(`organizations/${ORG}/members/cais3`).set({ role: 'member', status: 'approved', comptaAccess: { c1: ' Caissier ' } });
    await db.doc(`organizations/${ORG}/members/norole1`).set({ role: 'member', status: 'approved', comptaAccess: {} });

    // Invitation existante pour tests SEC-02
    await db.doc(`organizations/${ORG}/invitations/inv-seed`).set({
      orgId: ORG,
      uid: 'pending1',
      email: 'Pending1@X.ch',
      status: 'pending',
    });

    // Document journal d'e-mail existant pour tests SEC-04
    await db.doc('mail/m-seed').set({
      to: ['dest@x.ch'],
      subject: 'Audit',
      createdAt: '2026-11-25T00:00:00Z',
    });
  });
}

const dbOf = (uid, claims) => testEnv.authenticatedContext(uid, claims).firestore();
const anonDb = () => testEnv.unauthenticatedContext().firestore();

const newReceipt = (uid, extra = {}) => ({
  fileName: 'ticket.jpg',
  url: 'https://example.com/x.jpg',
  uploadDate: '2026-10-21',
  isAnalyzed: false,
  submittedByUid: uid,
  ...extra,
});

describe('[SEC-01] firestore.rules — rôle uploader', () => {
  beforeEach(seed);

  describe('Création de justificatifs (receipts)', () => {
    it("un uploader peut créer un justificatif rattaché à son uid", async () => {
      await assertSucceeds(dbOf('upl1').doc(`${C1}/receipts/new1`).set(newReceipt('upl1')));
    });

    it("un uploader peut créer un justificatif de remboursement avec statut PENDING", async () => {
      await assertSucceeds(
        dbOf('upl1').doc(`${C1}/receipts/new2`).set(newReceipt('upl1', { expenseType: 'REIMBURSEMENT', reimbursementStatus: 'PENDING', linkedTransactionId: null }))
      );
    });

    it("un uploader ne peut pas créer un justificatif au nom d'un autre utilisateur", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/new3`).set(newReceipt('cais1')));
    });

    it("un uploader ne peut pas créer un justificatif sans submittedByUid", async () => {
      const r = newReceipt('upl1');
      delete r.submittedByUid;
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/new4`).set(r));
    });

    it("un uploader ne peut pas créer un justificatif déjà marqué comme remboursé", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/n5`).set(newReceipt('upl1', { reimbursementStatus: 'REIMBURSED' })));
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/n6`).set(newReceipt('upl1', { reimbursedAt: 123 })));
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/n7`).set(newReceipt('upl1', { reimbursedByUid: 'upl1' })));
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/n8`).set(newReceipt('upl1', { reimbursedByName: 'x' })));
    });

    it("un uploader ne peut pas créer un justificatif déjà lié à une écriture ou transféré", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/n9`).set(newReceipt('upl1', { linkedTransactionId: 't1' })));
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/n10`).set(newReceipt('upl1', { transferRequest: { id: 'x' } })));
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/n11`).set(newReceipt('upl1', { transferHistory: [] })));
    });

    it("un uploader dont le rôle est lu depuis la sous-collection ET le profil org peut créer", async () => {
      await assertSucceeds(dbOf('upl2').doc(`${C1}/receipts/new12`).set(newReceipt('upl2')));
    });

    it("un uploader hérité (profil identifié par e-mail, casse différente) peut créer", async () => {
      await assertSucceeds(
        dbOf('leg1', { email: 'Legacy@X.ch' }).doc(`${C1}/receipts/new13`).set(newReceipt('leg1'))
      );
    });

    it("un utilisateur non connecté ne peut pas créer de justificatif", async () => {
      await assertFails(anonDb().doc(`${C1}/receipts/new14`).set(newReceipt('upl1')));
    });
  });

  describe('Lecture des justificatifs', () => {
    it("un uploader peut relire son propre justificatif", async () => {
      await assertSucceeds(dbOf('upl1').doc(`${C1}/receipts/r-upl1`).get());
    });

    it("un uploader ne peut pas lire le justificatif d'un autre", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/r-cais1`).get());
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/r-legacy`).get());
    });

    it("un uploader peut lister ses envois avec un filtre submittedByUid", async () => {
      await assertSucceeds(dbOf('upl1').collection(`${C1}/receipts`).where('submittedByUid', '==', 'upl1').get());
    });

    it("un uploader ne peut pas lister tous les justificatifs sans filtre", async () => {
      await assertFails(dbOf('upl1').collection(`${C1}/receipts`).get());
    });

    it("un uploader ne peut pas lister les envois d'un autre via filtre", async () => {
      await assertFails(dbOf('upl1').collection(`${C1}/receipts`).where('submittedByUid', '==', 'cais1').get());
    });

    it("un caissier, vérificateur ou lecteur lit tous les justificatifs", async () => {
      await assertSucceeds(dbOf('cais1').collection(`${C1}/receipts`).get());
      await assertSucceeds(dbOf('verif1').collection(`${C1}/receipts`).get());
      await assertSucceeds(dbOf('viewer1').collection(`${C1}/receipts`).get());
    });

    it("un utilisateur non connecté ne peut pas lire les justificatifs", async () => {
      await assertFails(anonDb().doc(`${C1}/receipts/r-upl1`).get());
    });
  });

  describe('Modification / suppression interdites pour un uploader', () => {
    it("ne peut pas modifier ni supprimer un justificatif (même le sien)", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/r-upl1`).update({ reimbursementStatus: 'REIMBURSED' }));
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/r-upl1`).delete());
      await assertFails(dbOf('upl1').doc(`${C1}/receipts/r-cais1`).delete());
    });

    it("ne peut pas créer, modifier ni supprimer une écriture comptable", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/transactions/t-new`).set({ amount: 1 }));
      await assertFails(dbOf('upl1').doc(`${C1}/transactions/t1`).update({ amount: 999 }));
      await assertFails(dbOf('upl1').doc(`${C1}/transactions/t1`).delete());
    });

    it("ne peut pas créer, modifier ni supprimer un compte", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/accounts/a-new`).set({ code: '9999' }));
      await assertFails(dbOf('upl1').doc(`${C1}/accounts/a1`).update({ name: 'Pirate' }));
      await assertFails(dbOf('upl1').doc(`${C1}/accounts/a1`).delete());
    });

    it("ne peut pas modifier les paramètres ni les catégories", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/settings/aiConfig`).set({ context: 'hack' }));
      await assertFails(dbOf('upl1').doc(`${C1}/categories/cat1`).delete());
    });

    it("ne peut pas écrire dans une sous-collection inconnue de la comptabilité", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/inconnue/x`).set({ a: 1 }));
    });

    it("ne peut pas modifier ni supprimer la comptabilité elle-même", async () => {
      await assertFails(dbOf('upl1').doc(C1).update({ name: 'Renommée' }));
      await assertFails(dbOf('upl1').doc(C1).delete());
    });

    it("ne peut pas s'auto-promouvoir dans les membres de la comptabilité", async () => {
      await assertFails(dbOf('upl1').doc(`${C1}/members/upl1`).update({ role: 'caissier' }));
      await assertFails(dbOf('upl1').doc(`${C1}/members/upl1`).delete());
      await assertFails(dbOf('upl1').doc(`${C1}/members/upl1`).set({ uid: 'upl1', role: 'comptable' }));
      await assertFails(dbOf('upl1').doc(`${C1}/members/autre`).set({ uid: 'autre', role: 'comptable' }));
    });

    it("un uploader ne peut pas modifier son propre profil membre d'organisation (même displayName)", async () => {
      await assertFails(dbOf('upl1').doc(`organizations/${ORG}/members/upl1`).update({ 'comptaAccess.c1': 'caissier' }));
      await assertFails(dbOf('upl1').doc(`organizations/${ORG}/members/upl1`).update({ displayName: 'Hack' }));
      await assertFails(dbOf('upl1').doc(`organizations/${ORG}/members/upl1`).delete());
      await assertFails(dbOf('upl1').doc(`organizations/${ORG}/members/upl1`).set({ role: 'admin', comptaAccess: { c1: 'caissier' } }));
    });

    it("un uploader hérité (e-mail) ne peut pas modifier son profil ni les écritures", async () => {
      const db = dbOf('leg1', { email: 'legacy@x.ch' });
      await assertFails(db.doc(`organizations/${ORG}/members/legacy@x.ch`).update({ 'comptaAccess.c1': 'caissier' }));
      await assertFails(db.doc(`${C1}/transactions/t1`).delete());
    });

    it("un rôle écrit avec espaces/majuscules (' Uploader ' / ' Caissier ') est correctement normalisé", async () => {
      await assertFails(dbOf('upl3').doc(`${C1}/transactions/t1`).delete());
      await assertSucceeds(dbOf('upl3').doc(`${C1}/receipts/new-upl3`).set(newReceipt('upl3')));
      await assertSucceeds(dbOf('cais3').doc(`${C1}/transactions/t1`).update({ amount: 42 }));
    });

    it("un uploader ne peut pas contourner la restriction en créant son profil uid (profil e-mail existant)", async () => {
      const db = dbOf('leg1', { email: 'legacy@x.ch' });
      await db.doc(`organizations/${ORG}/members/leg1`).set({ role: 'member', comptaAccess: { c1: 'caissier' } }).catch(() => {});
      await assertFails(db.doc(`${C1}/transactions/t1`).delete());
    });
  });

  describe('Robustesse face aux anciennes données (champs absents ou invalides)', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        // comptaAccess null / absent / mal typé, rôle non-string
        await db.doc(`organizations/${ORG}/members/old1`).set({ role: 'member', comptaAccess: null });
        await db.doc(`${C1}/members/old1`).set({ uid: 'old1', role: 'caissier' });
        await db.doc(`organizations/${ORG}/members/old2`).set({ role: 'member' });
        await db.doc(`${C1}/members/old2`).set({ uid: 'old2', role: 'caissier' });
        await db.doc(`organizations/${ORG}/members/old3`).set({ role: 42, comptaAccess: 'n/a' });
        await db.doc(`${C1}/members/old3`).set({ uid: 'old3', role: 'caissier' });
        await db.doc(`organizations/${ORG}/members/old4`).set({ role: 'member', comptaAccess: null });
        await db.doc(`${C1}/members/old4`).set({ uid: 'old4', role: 'uploader' });
        await db.doc(`${C1}/members/old5`).set({ uid: 'old5' });
      });
    });

    it("un caissier dont la fiche org a comptaAccess null/absent/invalide peut toujours écrire", async () => {
      await assertSucceeds(dbOf('old1').doc(`${C1}/transactions/t1`).delete());
      await assertSucceeds(dbOf('old2').doc(`${C1}/transactions/t-new`).set({ amount: 1 }));
      await assertSucceeds(dbOf('old3').doc(`${C1}/accounts/a1`).delete());
    });

    it("ces membres peuvent modifier leur propre fiche (comptaAccess null / absent / invalide)", async () => {
      await assertSucceeds(dbOf('old1').doc(`organizations/${ORG}/members/old1`).update({ displayName: 'a' }));
      await assertSucceeds(dbOf('old2').doc(`organizations/${ORG}/members/old2`).update({ displayName: 'b' }));
      await assertSucceeds(dbOf('old3').doc(`organizations/${ORG}/members/old3`).update({ displayName: 'c' }));
    });

    it("un uploader déclaré uniquement dans la sous-collection reste restreint (comptaAccess null)", async () => {
      await assertFails(dbOf('old4').doc(`${C1}/transactions/t1`).delete());
      await assertSucceeds(dbOf('old4').doc(`${C1}/receipts/o4`).set(newReceipt('old4')));
    });

    it("un membre de compta sans champ role n'est ni uploader ni bloqué (comportement historique)", async () => {
      await assertSucceeds(dbOf('old5').doc(`${C1}/transactions/t1`).delete());
    });
  });

  describe('Lectures conservées pour un uploader (connexion mobile)', () => {
    it("peut lire l'organisation, la comptabilité, les membres et les comptes", async () => {
      const db = dbOf('upl1');
      await assertSucceeds(db.doc(`organizations/${ORG}`).get());
      await assertSucceeds(db.doc(C1).get());
      await assertSucceeds(db.doc(`organizations/${ORG}/members/upl1`).get());
      await assertSucceeds(db.collection(`organizations/${ORG}/comptabilites`).get());
      await assertSucceeds(db.doc(`${C1}/members/upl1`).get());
      await assertSucceeds(db.doc(`${C1}/accounts/a1`).get());
    });

    it("peut lire collectionGroup('members') pour retrouver ses rôles", async () => {
      await assertSucceeds(dbOf('upl1').collectionGroup('members').get());
    });
  });

  describe('Aucune régression pour les autres rôles', () => {
    it("un caissier peut écrire/supprimer écritures, comptes, paramètres et justificatifs", async () => {
      const db = dbOf('cais1');
      await assertSucceeds(db.doc(`${C1}/transactions/t-new`).set({ amount: 1 }));
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).update({ amount: 20 }));
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).delete());
      await assertSucceeds(db.doc(`${C1}/accounts/a-new`).set({ code: '2000' }));
      await assertSucceeds(db.doc(`${C1}/settings/aiConfig`).set({ context: 'ok' }));
      await assertSucceeds(db.doc(`${C1}/receipts/rc1`).set(newReceipt('cais1', { reimbursementStatus: 'REIMBURSED', reimbursedAt: 1 })));
      await assertSucceeds(db.doc(`${C1}/receipts/r-upl1`).update({ reimbursementStatus: 'REIMBURSED' }));
      await assertSucceeds(db.doc(`${C1}/receipts/r-upl1`).delete());
    });

    it("un caissier peut gérer les membres de la comptabilité et la comptabilité", async () => {
      const db = dbOf('cais1');
      await assertSucceeds(db.doc(`${C1}/members/nouveau`).set({ uid: 'nouveau', role: 'viewer' }));
      await assertSucceeds(db.doc(`${C1}/members/upl1`).update({ role: 'caissier' }));
      await assertSucceeds(db.doc(C1).update({ name: 'Renommée' }));
    });

    it("un caissier peut transférer un justificatif vers une autre comptabilité (transaction multi-docs)", async () => {
      const db = dbOf('cais1');
      await assertSucceeds(db.runTransaction(async (tx) => {
        const src = db.doc(`${C1}/receipts/r-cais1`);
        await tx.get(src);
        tx.set(db.doc(`${C2}/receipts/r-cais1`), newReceipt('cais1', { transferRequest: { fromComptaId: 'c1', toComptaId: 'c2', status: 'PENDING_ACCEPTANCE' } }));
        tx.delete(src);
      }));
    });

    it("un vérificateur peut proposer/commenter une écriture sans modifier montant ni date ; un lecteur peut commenter uniquement", async () => {
      await assertSucceeds(dbOf('verif1').doc(`${C1}/transactions/t1`).update({ status: 'PROPOSED', verifierProposal: { proposedAccountId: 'a1' } }));
      await assertFails(dbOf('verif1').doc(`${C1}/transactions/t1`).update({ amount: 999 }));
      await assertFails(dbOf('verif1').doc(`${C1}/transactions/t1`).update({ date: '2026-01-01' }));
      await assertFails(dbOf('verif1').doc(`${C1}/transactions/t1`).delete());
      await assertSucceeds(dbOf('viewer1').doc(`${C1}/transactions/t1`).update({ comments: [{ id: 'c1', text: 'note' }] }));
      await assertFails(dbOf('viewer1').doc(`${C1}/receipts/rv`).set(newReceipt('viewer1')));
    });

    it("un uploader sur c1 mais caissier sur c2 peut écrire dans c2 uniquement", async () => {
      const db = dbOf('upl2');
      await assertSucceeds(db.doc(`${C2}/transactions/t1`).delete());
      await assertSucceeds(db.doc(`${C2}/transactions/t-new`).set({ amount: 5 }));
      await assertFails(db.doc(`${C1}/transactions/t1`).delete());
    });

    it("un admin d'organisation qui a aussi le rôle uploader n'est pas restreint", async () => {
      const db = dbOf('adminupl');
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).delete());
      await assertSucceeds(db.doc(`${C1}/receipts/r-cais1`).delete());
      await assertSucceeds(db.doc(`${C1}/members/adminupl`).update({ role: 'comptable' }));
    });

    it("un admin d'organisation ayant aussi un rôle uploader peut modifier sa propre fiche membre", async () => {
      await assertSucceeds(dbOf('adminupl').doc(`organizations/${ORG}/members/adminupl`).update({ displayName: 'Admin' }));
    });

    it("un super-admin (claim) n'est pas restreint même avec un rôle uploader", async () => {
      const db = dbOf('sa1', { superAdmin: true });
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).delete());
    });

    it("un utilisateur sans rôle sur la comptabilité conserve le comportement historique (super-admins codés en dur)", async () => {
      const db = dbOf('stranger', { email: 'jean-francois@knebel.ch' });
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).update({ amount: 2 }));
      await assertSucceeds(db.doc(`${C1}/receipts/r-cais1`).get());
    });

    it("création d'une nouvelle comptabilité et de son premier membre (flux createComptabilite)", async () => {
      const db = dbOf('cais1');
      await assertSucceeds(db.doc(`organizations/${ORG}/comptabilites/c3`).set({ name: 'Nouvelle', createdBy: 'cais1' }));
      await assertSucceeds(db.doc(`organizations/${ORG}/comptabilites/c3/members/cais1`).set({ uid: 'cais1', role: 'comptable' }));
      await assertSucceeds(db.doc(`organizations/${ORG}/comptabilites/c3/accounts/a1`).set({ code: '1' }));
      // Impossible de créer une compta avec un createdBy forgé ou absent
      await assertFails(db.doc(`organizations/${ORG}/comptabilites/c4`).set({ name: 'Forged', createdBy: 'orgadmin' }));
      await assertFails(db.doc(`organizations/${ORG}/comptabilites/c5`).set({ name: 'NoOwner' }));
    });

    it("demande d'adhésion : un nouvel utilisateur crée sa propre fiche membre et invitation", async () => {
      const db = dbOf('newbie', { email: 'newbie@x.ch' });
      await assertSucceeds(db.doc(`organizations/${ORG}/members/newbie`).set({ role: 'member', status: 'pending' }));
      await assertSucceeds(db.doc(`organizations/${ORG}/invitations/inv1`).set({ uid: 'newbie', status: 'pending' }));
    });

    it("un membre non-uploader peut modifier sa propre fiche membre", async () => {
      await assertSucceeds(dbOf('cais1').doc(`organizations/${ORG}/members/cais1`).update({ displayName: 'Cais' }));
    });

    it("un admin d'organisation peut gérer les fiches membres (y compris celles des uploaders)", async () => {
      const db = dbOf('orgadmin');
      await assertSucceeds(db.doc(`organizations/${ORG}/members/upl1`).update({ 'comptaAccess.c1': 'caissier' }));
      await assertSucceeds(db.doc(`organizations/${ORG}/members/upl2`).delete());
    });

    it("l'admin peut supprimer un compte uploader depuis l'app web (membre de la compta)", async () => {
      await assertSucceeds(dbOf('orgadmin').doc(`${C1}/members/upl1`).delete());
    });

    it("l'écriture sur le document de l'organisation est réservée à l'admin d'organisation (SEC-02)", async () => {
      await assertSucceeds(dbOf('orgadmin').doc(`organizations/${ORG}`).update({ name: 'Renommée' }));
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}`).update({ name: 'Renommée' }));
      await assertFails(anonDb().doc(`organizations/${ORG}`).update({ name: 'Pirate' }));
      await assertSucceeds(anonDb().doc(`organizations/${ORG}`).get());
    });

    it("un utilisateur non connecté ne peut rien écrire ni lire dans la comptabilité", async () => {
      await assertFails(anonDb().doc(`${C1}/transactions/t1`).get());
      await assertFails(anonDb().doc(`${C1}/transactions/t1`).delete());
      await assertFails(anonDb().doc(`${C1}/members/upl1`).get());
    });

    it("règles /users inchangées : seul le propriétaire écrit son profil", async () => {
      await assertSucceeds(dbOf('u9').doc('users/u9').set({ email: 'u9@x.ch' }));
      await assertFails(dbOf('u8').doc('users/u9').update({ email: 'hack@x.ch' }));
      await assertSucceeds(dbOf('u9').doc('users/u9/accounts/a1').set({ code: '1' }));
      await assertFails(dbOf('u8').doc('users/u9/accounts/a1').get());
    });
  });

  describe('[SEC-01] Isolation inter-comptabilités, statuts pending/rejected et moindre privilège', () => {
    it("isolation stricte : un uploader ou caissier sur c1 n'a aucun accès aux écritures/comptes/paramètres/reçus existants de c2", async () => {
      // upl1 (uploader c1) bloqué sur c2 (lecture, création reçu, écritures)
      await assertFails(dbOf('upl1').doc(`${C2}/transactions/t1`).get());
      await assertFails(dbOf('upl1').doc(`${C2}/accounts/a1`).get());
      await assertFails(dbOf('upl1').doc(`${C2}/receipts/r-c2`).get());
      await assertFails(dbOf('upl1').doc(`${C2}/receipts/new-c2`).set(newReceipt('upl1')));
      await assertFails(dbOf('upl1').doc(`${C2}/transactions/t1`).delete());

      // cais1 (caissier c1) bloqué en lecture/modification/suppression sur c2
      await assertFails(dbOf('cais1').doc(`${C2}/transactions/t1`).get());
      await assertFails(dbOf('cais1').doc(`${C2}/transactions/t1`).update({ amount: 999 }));
      await assertFails(dbOf('cais1').doc(`${C2}/transactions/t1`).delete());
      await assertFails(dbOf('cais1').doc(`${C2}/accounts/a1`).get());
      await assertFails(dbOf('cais1').doc(`${C2}/accounts/a1`).delete());
      await assertFails(dbOf('cais1').doc(`${C2}/receipts/r-c2`).get());
      await assertFails(dbOf('cais1').doc(`${C2}/receipts/r-c2`).delete());
      await assertFails(dbOf('cais1').doc(C2).update({ name: 'Hijack' }));
      await assertFails(dbOf('cais1').doc(`${C2}/members/cais1`).set({ uid: 'cais1', role: 'caissier' }));
    });

    it("un inscrit sans rôle ni membre pending/rejected ne peut rien lire ni écrire dans c1", async () => {
      for (const uid of ['norole1', 'pending1', 'orgpending', 'rejected1', 'stranger99']) {
        await assertFails(dbOf(uid).doc(`${C1}/transactions/t1`).get());
        await assertFails(dbOf(uid).doc(`${C1}/accounts/a1`).get());
        await assertFails(dbOf(uid).doc(`${C1}/settings/aiConfig`).get());
        await assertFails(dbOf(uid).doc(`${C1}/receipts/r-upl1`).get());
        await assertFails(dbOf(uid).doc(`${C1}/receipts/x-${uid}`).set(newReceipt(uid)));
        await assertFails(dbOf(uid).doc(`${C1}/rentals/rent1`).get());
        await assertFails(dbOf(uid).doc(`organizations/${ORG}/comptabilites/c-new-${uid}`).set({ name: 'Rogue', createdBy: uid }));
      }
    });

    it("moindre privilège : viewer est strictement lecture seule (+ commentaires sur transactions)", async () => {
      const db = dbOf('viewer1');
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).get());
      await assertSucceeds(db.doc(`${C1}/accounts/a1`).get());
      await assertSucceeds(db.doc(`${C1}/settings/aiConfig`).get());
      await assertSucceeds(db.doc(`${C1}/rentals/rent1`).get());
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).update({ comments: [{ id: '1', text: 'ok' }] }));

      await assertFails(db.doc(`${C1}/transactions/t-new`).set({ amount: 5 }));
      await assertFails(db.doc(`${C1}/transactions/t1`).update({ amount: 500 }));
      await assertFails(db.doc(`${C1}/transactions/t1`).update({ status: 'APPROVED' }));
      await assertFails(db.doc(`${C1}/transactions/t1`).delete());
      await assertFails(db.doc(`${C1}/accounts/a1`).update({ code: '9999' }));
      await assertFails(db.doc(`${C1}/settings/aiConfig`).set({ context: 'evil' }));
      await assertFails(db.doc(`${C1}/members/viewer1`).update({ role: 'caissier' }));
      await assertFails(db.doc(`${C1}/rentals/rent1`).update({ amount: 0 }));
      await assertFails(db.doc(C1).update({ name: 'Hijack' }));
      await assertFails(db.doc(`organizations/${ORG}/comptabilites/c-new`).set({ name: 'No' }));
    });

    it("moindre privilège : verificateur peut proposer/commenter/lier mais ne peut pas altérer montants, dates, comptes ou membres", async () => {
      const db = dbOf('verif1');
      await assertSucceeds(db.doc(`${C1}/transactions/t1`).update({ status: 'PROPOSED', accountId: 'a1' }));
      await assertSucceeds(db.doc(`${C1}/receipts/r-cais1`).update({ linkedTransactionId: 't1' }));

      await assertFails(db.doc(`${C1}/transactions/t-new`).set({ amount: 5 }));
      await assertFails(db.doc(`${C1}/transactions/t1`).update({ amount: 123 }));
      await assertFails(db.doc(`${C1}/transactions/t1`).update({ date: '2020-01-01' }));
      await assertFails(db.doc(`${C1}/transactions/t1`).update({ id: 'fake' }));
      await assertFails(db.doc(`${C1}/transactions/t1`).update({ runningBalance: 0 }));
      await assertFails(db.doc(`${C1}/transactions/t1`).delete());
      await assertFails(db.doc(`${C1}/receipts/r-cais1`).update({ reimbursementStatus: 'REIMBURSED' }));
      await assertFails(db.doc(`${C1}/receipts/r-cais1`).delete());
      await assertFails(db.doc(`${C1}/accounts/a1`).update({ code: '9999' }));
      await assertFails(db.doc(`${C1}/members/verif1`).update({ role: 'caissier' }));
    });

    it("moindre privilège : responsable_location gère rentals/reçus propres/notifications mais pas les écritures ni la compta", async () => {
      const db = dbOf('loc1');
      await assertSucceeds(db.doc(`${C1}/rentals/rent1`).get());
      await assertSucceeds(db.doc(`${C1}/rentals/rent-new`).set({ renterName: 'A', amount: 50 }));
      await assertSucceeds(db.doc(`${C1}/notifications/n1`).set({ type: 'RENTAL' }));
      await assertSucceeds(db.doc(`${C1}/receipts/r-loc1`).set(newReceipt('loc1')));
      await assertSucceeds(db.doc(`${C1}/accounts/a1`).get());

      await assertFails(db.doc(`${C1}/transactions/t1`).get());
      await assertFails(db.doc(`${C1}/transactions/t1`).update({ amount: 1 }));
      await assertFails(db.doc(`${C1}/accounts/a1`).update({ code: '9999' }));
      await assertFails(db.doc(`${C1}/receipts/r-cais1`).get());
      await assertFails(db.doc(`${C1}/members/loc1`).set({ uid: 'loc1', role: 'caissier' }));
    });

    it("valeurs limites : rôle 'admin' interdit en écriture dans comptabilites/{comptaId}/members par un caissier", async () => {
      await assertFails(dbOf('cais1').doc(`${C1}/members/upl1`).update({ role: 'admin' }));
      await assertFails(dbOf('cais1').doc(`${C1}/members/newadmin`).set({ uid: 'newadmin', role: 'admin' }));
      await assertFails(dbOf('cais1').doc(`${C1}/members/bad`).set({ uid: 'bad', role: '' }));
      await assertFails(dbOf('cais1').doc(`${C1}/members/bad2`).set({ uid: 'bad2', role: 123 }));
    });
  });

  describe('[SEC-02] Anti-élévation de privilèges sur /organizations, /members et /invitations', () => {
    it("POSITIF : SuperAdmin crée/supprime une organisation et change adminEmail/adminUid ; OrgAdmin modifie name/inviteCode/customFields", async () => {
      const sa = dbOf('sa-user', { superAdmin: true });
      await assertSucceeds(sa.doc('organizations/org-new').set({ name: 'Nouvelle Asso', createdBy: 'sa-user', adminEmail: 'a@x.ch' }));
      await assertSucceeds(sa.doc('organizations/org-new').update({ adminEmail: 'b@x.ch', adminUid: 'u2' }));
      await assertSucceeds(sa.doc('organizations/org-new').delete());

      await assertSucceeds(dbOf('orgadmin').doc(`organizations/${ORG}`).update({ inviteCode: 'NEWCODE', customFields: [] }));
    });

    it("NÉGATIF : non-SuperAdmin ne peut ni créer/supprimer d'organisation ni changer createdBy/adminEmail/adminUid", async () => {
      await assertFails(dbOf('orgadmin').doc('organizations/org-rogue').set({ name: 'Rogue' }));
      await assertFails(dbOf('orgadmin').doc(`organizations/${ORG}`).delete());
      await assertFails(dbOf('orgadmin').doc(`organizations/${ORG}`).update({ adminEmail: 'hacker@x.ch' }));
      await assertFails(dbOf('orgadmin').doc(`organizations/${ORG}`).update({ adminUid: 'hacker' }));
      await assertFails(dbOf('orgadmin').doc(`organizations/${ORG}`).update({ createdBy: 'hacker' }));
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}`).update({ inviteCode: 'HIJACK' }));
      await assertFails(dbOf('upl1').doc(`organizations/${ORG}`).update({ name: 'Hijack' }));
    });

    it("NÉGATIF & LIMITES : impossible de s'auto-inscrire ou créer un membre org privilégié (admin, approved, comptaAccess non vide, uid forgé)", async () => {
      // Un caissier/uploader ne peut créer aucun membre dans organizations/{orgId}/members
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}/members/rogue1`).set({ role: 'admin', status: 'approved' }));
      await assertFails(dbOf('upl1').doc(`organizations/${ORG}/members/rogue2`).set({ role: 'admin', status: 'approved' }));

      // Un nouvel inscrit ne peut pas s'auto-accorder role != member, status != pending, comptaAccess non vide ou uid d'autrui
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/members/newbie`).set({ role: 'admin', status: 'pending' }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/members/newbie`).set({ role: 'caissier', status: 'pending' }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/members/newbie`).set({ role: 'member', status: 'approved' }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/members/newbie`).set({ role: 'member' }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/members/newbie`).set({ role: 'member', status: 'pending', comptaAccess: { c1: 'caissier' } }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/members/newbie`).set({ role: 'member', status: 'pending', uid: 'orgadmin' }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/members/autre`).set({ role: 'member', status: 'pending' }));

      // Un membre non-uploader ne peut pas modifier son status, uid, role ou comptaAccess sur sa propre fiche
      await assertFails(dbOf('pending1').doc(`organizations/${ORG}/members/pending1`).update({ status: 'approved' }));
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}/members/cais1`).update({ role: 'admin' }));
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}/members/cais1`).update({ uid: 'orgadmin' }));
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}/members/cais1`).update({ 'comptaAccess.c2': 'caissier' }));
    });

    it("POSITIF, NÉGATIF & LIMITES : /invitations et collectionGroup('invitations')", async () => {
      // Positif : créateur lit sa propre invitation (uid ou email) et orgadmin lit/approuve/supprime
      await assertSucceeds(dbOf('pending1').doc(`organizations/${ORG}/invitations/inv-seed`).get());
      await assertSucceeds(dbOf('other-uid', { email: 'pending1@x.ch' }).doc(`organizations/${ORG}/invitations/inv-seed`).get());
      await assertSucceeds(dbOf('orgadmin').doc(`organizations/${ORG}/invitations/inv-seed`).get());
      await assertSucceeds(dbOf('pending1').collectionGroup('invitations').where('uid', '==', 'pending1').get());
      await assertSucceeds(dbOf('orgadmin').collectionGroup('invitations').where('orgId', '==', ORG).get());
      await assertSucceeds(dbOf('orgadmin').doc(`organizations/${ORG}/invitations/inv-seed`).update({ status: 'approved', reviewedBy: 'orgadmin' }));

      // Négatif : un tiers ne peut ni lire, ni modifier, ni supprimer l'invitation d'autrui, ni créer avec status/uid/orgId forgé
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}/invitations/inv-seed`).get());
      await assertFails(dbOf('cais1').collectionGroup('invitations').get());
      await assertFails(dbOf('pending1').doc(`organizations/${ORG}/invitations/inv-seed`).update({ status: 'approved' }));
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}/invitations/inv-seed`).update({ status: 'approved' }));
      await assertFails(dbOf('cais1').doc(`organizations/${ORG}/invitations/inv-seed`).delete());
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/invitations/inv-bad1`).set({ uid: 'newbie', status: 'approved', orgId: ORG }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/invitations/inv-bad2`).set({ uid: 'orgadmin', status: 'pending', orgId: ORG }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/invitations/inv-bad3`).set({ uid: 'newbie', status: 'pending', orgId: 'autre-org' }));
      await assertFails(dbOf('newbie').doc(`organizations/${ORG}/invitations/inv-bad4`).set({ uid: 'newbie' }));
      await assertFails(anonDb().doc(`organizations/${ORG}/invitations/inv-seed`).get());
    });
  });
});

describe('[SEC-01] storage.rules — justificatifs', () => {
  beforeEach(seed);

  const bytes = (size) => new Uint8Array(size);
  const storageOf = (uid, claims) => (uid ? testEnv.authenticatedContext(uid, claims).storage() : testEnv.unauthenticatedContext().storage());
  const put = (uid, p, size, contentType, claims) =>
    storageOf(uid, claims).ref(p).put(bytes(size), contentType === undefined ? undefined : { contentType });

  it('un utilisateur autorisé peut déposer une image JPEG ou PNG dans receipts/{orgId}/{comptaId}/', async () => {
    await assertSucceeds(put('upl1', 'receipts/o1/c1/photo1.jpg', 1 * MB, 'image/jpeg'));
    await assertSucceeds(put('upl1', 'receipts/o1/c1/photo2.png', 1000, 'image/png'));
  });

  it('un utilisateur autorisé peut déposer un PDF', async () => {
    await assertSucceeds(put('upl1', 'receipts/o1/c1/facture.pdf', 2 * MB, 'application/pdf'));
  });

  it('la limite est strictement comprise entre 1 octet et < 5 Mo', async () => {
    await assertSucceeds(put('upl1', 'receipts/o1/c1/limite_min.jpg', 1, 'image/jpeg'));
    await assertSucceeds(put('upl1', 'receipts/o1/c1/limite_ok.jpg', 5 * MB - 1, 'image/jpeg'));
    await assertFails(put('upl1', 'receipts/o1/c1/vide.jpg', 0, 'image/jpeg'));
    await assertFails(put('upl1', 'receipts/o1/c1/limite_ko.jpg', 5 * MB, 'image/jpeg'));
    await assertFails(put('upl1', 'receipts/o1/c1/gros.pdf', 6 * MB, 'application/pdf'));
  });

  it('refuse les types de fichiers autres que images sûres et application/pdf (dont SVG)', async () => {
    await assertFails(put('upl1', 'receipts/o1/c1/xss.svg', 100, 'image/svg+xml'));
    await assertFails(put('upl1', 'receipts/o1/c1/script.js', 100, 'application/javascript'));
    await assertFails(put('upl1', 'receipts/o1/c1/note.txt', 100, 'text/plain'));
    await assertFails(put('upl1', 'receipts/o1/c1/app.exe', 100, 'application/octet-stream'));
    await assertFails(put('upl1', 'receipts/o1/c1/page.html', 100, 'text/html'));
    await assertFails(put('upl1', 'receipts/o1/c1/fake.pdf.exe', 100, 'application/x-msdownload'));
  });

  it("refuse un type qui contient seulement 'pdf' ou 'image' sans correspondre exactement", async () => {
    await assertFails(put('upl1', 'receipts/o1/c1/a.bin', 100, 'application/pdfx'));
    await assertFails(put('upl1', 'receipts/o1/c1/b.bin', 100, 'x-image/png'));
    await assertFails(put('upl1', 'receipts/o1/c1/c.bin', 100, 'text/plain; image/png'));
  });

  it('refuse les dépôts non authentifiés', async () => {
    await assertFails(put(null, 'receipts/o1/c1/anon.jpg', 100, 'image/jpeg'));
  });

  it('refuse tout dépôt hors du dossier receipts/', async () => {
    await assertFails(put('upl1', 'autre/o1/c1/photo.jpg', 100, 'image/jpeg'));
    await assertFails(put('upl1', 'photo.jpg', 100, 'image/jpeg'));
  });

  it("espace personnel receipts/{uid}/ limité strictement au propriétaire, receipts/public/ et racine fermés", async () => {
    await assertSucceeds(put('upl1', 'receipts/upl1/old.jpg', 100, 'image/jpeg'));
    await assertSucceeds(storageOf('upl1').ref('receipts/upl1/old.jpg').getDownloadURL());
    await assertFails(put('upl1', 'receipts/upl1/old.txt', 100, 'text/plain'));
    await assertFails(put('upl1', 'receipts/upl1/xss.svg', 100, 'image/svg+xml'));
    await assertFails(put('upl1', 'receipts/upl1/gros.jpg', 6 * MB, 'image/jpeg'));

    // Cross-user et chemins publics/racine bloqués (SEC-03)
    await assertFails(storageOf('cais1').ref('receipts/upl1/old.jpg').getDownloadURL());
    await assertFails(put('cais1', 'receipts/upl1/intrusion.jpg', 100, 'image/jpeg'));
    await assertFails(storageOf('cais1').ref('receipts/upl1/old.jpg').delete());
    await assertSucceeds(storageOf('upl1').ref('receipts/upl1/old.jpg').delete());

    await assertFails(put('upl1', 'receipts/public/old.pdf', 100, 'application/pdf'));
    await assertFails(put('public', 'receipts/public/old.jpg', 100, 'image/jpeg'));
    await assertFails(put('upl1', 'receipts/fichier.png', 100, 'image/png'));
  });

  it('la lecture et la suppression respectent le RBAC de la comptabilité', async () => {
    await put('upl1', 'receipts/o1/c1/lecture.jpg', 100, 'image/jpeg');
    await assertSucceeds(storageOf('cais1').ref('receipts/o1/c1/lecture.jpg').getDownloadURL());
    await assertSucceeds(storageOf('viewer1').ref('receipts/o1/c1/lecture.jpg').getDownloadURL());
    await assertFails(storageOf(null).ref('receipts/o1/c1/lecture.jpg').getDownloadURL());
    await assertFails(storageOf('stranger').ref('receipts/o1/c1/lecture.jpg').getDownloadURL());
    await assertFails(storageOf('pending1').ref('receipts/o1/c1/lecture.jpg').getDownloadURL());

    await assertFails(storageOf(null).ref('receipts/o1/c1/lecture.jpg').delete());
    await assertFails(storageOf('upl1').ref('receipts/o1/c1/lecture.jpg').delete());
    await assertFails(storageOf('viewer1').ref('receipts/o1/c1/lecture.jpg').delete());
    await assertSucceeds(storageOf('cais1').ref('receipts/o1/c1/lecture.jpg').delete());
  });

  it("un fichier existant ne peut pas être remplacé par un uploader ni par un contenu non conforme", async () => {
    await put('upl1', 'receipts/o1/c1/remplace.jpg', 100, 'image/jpeg');
    await assertFails(put('upl1', 'receipts/o1/c1/remplace.jpg', 100, 'image/jpeg'));
    await assertFails(put('upl1', 'receipts/o1/c1/remplace.jpg', 100, 'text/html'));
    await assertFails(put('upl1', 'receipts/o1/c1/remplace.jpg', 6 * MB, 'image/jpeg'));
    await assertFails(put('cais1', 'receipts/o1/c1/remplace.jpg', 100, 'text/html'));
    await assertFails(put('cais1', 'receipts/o1/c1/remplace.jpg', 100, 'image/svg+xml'));
    await assertSucceeds(put('cais1', 'receipts/o1/c1/remplace.jpg', 200, 'image/jpeg'));
    await assertFails(storageOf('upl1').ref('receipts/o1/c1/remplace.jpg').updateMetadata({ contentType: 'image/jpeg' }));
    await assertFails(storageOf('cais1').ref('receipts/o1/c1/remplace.jpg').updateMetadata({ contentType: 'text/html' }));
    await assertFails(storageOf('cais1').ref('receipts/o1/c1/remplace.jpg').updateMetadata({ contentType: 'image/svg+xml' }));
    await assertSucceeds(storageOf('cais1').ref('receipts/o1/c1/remplace.jpg').updateMetadata({ customMetadata: { rev: '2' } }));
  });
});

describe('[SEC-03] storage.rules — isolation inter-comptabilités et rôles', () => {
  beforeEach(seed);

  const bytes = (size) => new Uint8Array(size);
  const storageOf = (uid, claims) => (uid ? testEnv.authenticatedContext(uid, claims).storage() : testEnv.unauthenticatedContext().storage());
  const put = (uid, p, size, contentType, claims) =>
    storageOf(uid, claims).ref(p).put(bytes(size), contentType === undefined ? undefined : { contentType });

  it('POSITIF : responsable_location, orgadmin et superAdmin accèdent conformément à leur rôle', async () => {
    await assertSucceeds(put('loc1', 'receipts/o1/c1/loc.webp', 512, 'image/webp'));
    await assertSucceeds(put('orgadmin', 'receipts/o1/c2/admin.png', 512, 'image/png'));
    await assertSucceeds(put('sa-user', 'receipts/o1/c2/sa.pdf', 512, 'application/pdf', { superAdmin: true }));
    await assertSucceeds(storageOf('orgadmin').ref('receipts/o1/c2/admin.png').delete());
  });

  it('NÉGATIF & LIMITES : isolation c1/c2, refus viewer/verificateur/pending/rejected en écriture', async () => {
    await assertFails(put('upl1', 'receipts/o1/c2/cross.jpg', 100, 'image/jpeg'));
    await assertFails(put('viewer1', 'receipts/o1/c1/viewer.jpg', 100, 'image/jpeg'));
    await assertFails(put('verif1', 'receipts/o1/c1/verif.jpg', 100, 'image/jpeg'));
    await assertFails(put('pending1', 'receipts/o1/c1/pending.jpg', 100, 'image/jpeg'));
    await assertFails(put('rejected1', 'receipts/o1/c1/rejected.jpg', 100, 'image/jpeg'));
    await assertFails(put('norole1', 'receipts/o1/c1/norole.jpg', 100, 'image/jpeg'));

    await put('cais1', 'receipts/o1/c1/locked.jpg', 100, 'image/jpeg');
    await assertFails(storageOf('upl1').ref('receipts/o1/c2/cross_read.jpg').getDownloadURL());
    await assertFails(put('upl1', 'receipts/o1/c1/img.webp', 0, 'image/webp'));
  });
});

describe('[SEC-04] firestore.rules — verrouillage /mail', () => {
  beforeEach(seed);

  it('POSITIF : seul un SuperAdmin peut lire le journal /mail', async () => {
    await assertSucceeds(dbOf('sa-user', { superAdmin: true }).doc('mail/m-seed').get());
  });

  it('NÉGATIF & LIMITES : aucun client (même SuperAdmin/OrgAdmin/Caissier) ne peut écrire dans /mail et les non-SuperAdmin ne peuvent pas le lire', async () => {
    await assertFails(dbOf('orgadmin').doc('mail/m-seed').get());
    await assertFails(dbOf('cais1').doc('mail/m-seed').get());
    await assertFails(dbOf('upl1').doc('mail/m-seed').get());
    await assertFails(anonDb().doc('mail/m-seed').get());

    await assertFails(dbOf('cais1').doc('mail/m-new').set({ to: ['x@x.ch'] }));
    await assertFails(dbOf('orgadmin').doc('mail/m-new').set({ to: ['x@x.ch'] }));
    await assertFails(dbOf('sa-user', { superAdmin: true }).doc('mail/m-new').set({ to: ['x@x.ch'] }));
    await assertFails(dbOf('sa-user', { superAdmin: true }).doc('mail/m-seed').update({ subject: 'Tamper' }));
    await assertFails(dbOf('sa-user', { superAdmin: true }).doc('mail/m-seed').delete());
  });
});
