import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_TRANSFER_NOTE_LENGTH,
    MAX_TRANSFER_HISTORY,
    canTransferReceipt,
    formatReceiptAmountChf,
    formatReceiptDateFr,
    buildTransferConfirmationMessage,
    getEligibleTargetComptas,
    normalizeTransferNote,
    isSafeDocId,
    validateReceiptTransfer,
    buildTransferredReceipt,
    buildAcceptedReceipt,
    isPendingIncomingTransfer,
    receiptDocPath,
    comptaDocPath,
    transactionDocPath,
    performReceiptTransfer
} from '../receiptTransfer.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = 1792569600000;
const actor = { uid: 'u-caissier', name: 'Marc Caissier', email: 'marc@asso.ch' };
const louveteaux = { id: 'c-louv', name: 'Louveteaux 26-27', isArchived: false };
const pionnier = { id: 'c-pio', name: 'Pionnier 26-27', isArchived: false };
const archived = { id: 'c-old', name: 'Pionnier 24-25', isArchived: true };

const baseReceipt = () => ({
    id: 'rcpt-1',
    url: 'https://storage/receipts/org/c-louv/ticket.jpg',
    fileName: '123_ticket.jpg',
    uploadDate: '2026-10-20',
    extractedDate: '2026-10-18',
    extractedAmount: 42.5,
    isAnalyzed: true,
    expenseType: 'REIMBURSEMENT',
    submittedByName: 'Alexandre'
});

const validInput = (overrides = {}) => ({
    receipt: baseReceipt(),
    fromComptaId: louveteaux.id,
    targetCompta: pionnier,
    requestedByUid: actor.uid,
    note: '',
    ...overrides
});

/** Faux Firestore transactionnel en mémoire (lectures immédiates, écritures différées jusqu'au commit). */
const createMemoryDb = (initial = {}) => {
    const store = new Map(Object.entries(initial));
    const key = (path) => path.join('/');
    return {
        store,
        async run(fn) {
            const pending = [];
            let writesStarted = false;
            const tx = {
                async get(path) {
                    if (writesStarted) throw new Error('Firestore: toutes les lectures doivent précéder les écritures');
                    const k = key(path);
                    return store.has(k) ? { exists: true, data: structuredClone(store.get(k)) } : { exists: false };
                },
                set(path, data) { writesStarted = true; pending.push(['set', key(path), structuredClone(data)]); },
                delete(path) { writesStarted = true; pending.push(['delete', key(path)]); }
            };
            const result = await fn(tx); // une exception => aucun commit (rollback)
            for (const [op, k, data] of pending) {
                if (op === 'set') store.set(k, data); else store.delete(k);
            }
            return result;
        }
    };
};

const seedDb = (receiptOverrides = {}, extra = {}) => {
    const r = { ...baseReceipt(), ...receiptOverrides };
    return createMemoryDb({
        [comptaDocPath('org1', louveteaux.id).join('/')]: { name: louveteaux.name, isArchived: false },
        [comptaDocPath('org1', pionnier.id).join('/')]: { name: pionnier.name, isArchived: false },
        [comptaDocPath('org1', archived.id).join('/')]: { name: archived.name, isArchived: true },
        [receiptDocPath('org1', louveteaux.id, r.id).join('/')]: r,
        ...extra
    });
};

const transferParams = (overrides = {}) => ({
    orgId: 'org1',
    fromComptaId: louveteaux.id,
    toComptaId: pionnier.id,
    receiptId: 'rcpt-1',
    requestedBy: actor,
    note: 'Envoyée par erreur',
    now: NOW,
    ...overrides
});

// ===========================================================================
// UNIT — CAS POSITIFS
// ===========================================================================
describe('WEB-03 — Unit : cas positifs', () => {
    it('canTransferReceipt autorise caissier, comptable (legacy), admin, admin org et super-admin', () => {
        assert.equal(canTransferReceipt('caissier'), true);
        assert.equal(canTransferReceipt('comptable'), true);
        assert.equal(canTransferReceipt('admin'), true);
        assert.equal(canTransferReceipt(null, true, false), true);
        assert.equal(canTransferReceipt(undefined, false, true), true);
        assert.equal(canTransferReceipt('viewer', true), true);
    });

    it('validateReceiptTransfer accepte un transfert nominal', () => {
        assert.equal(validateReceiptTransfer(validInput()), null);
    });

    it('le message de confirmation contient montant, date JJ/MM/AAAA et nom de la compta cible', () => {
        assert.equal(
            buildTransferConfirmationMessage(baseReceipt(), 'Pionnier 26-27'),
            'Êtes-vous sûr de vouloir transférer cette pièce justificative (CHF 42.50 du 18/10/2026) vers la comptabilité « Pionnier 26-27 » ?'
        );
    });

    it('getEligibleTargetComptas exclut la source et les archivées, et trie par nom', () => {
        const zeta = { id: 'c-z', name: 'Zeta' };
        const alpha = { id: 'c-a', name: 'Alpha' };
        const result = getEligibleTargetComptas([zeta, louveteaux, archived, pionnier, alpha], louveteaux.id);
        assert.deepEqual(result.map(c => c.id), ['c-a', 'c-pio', 'c-z']);
    });

    it('buildTransferredReceipt ajoute transferRequest complet, supprime le lien et conserve les données métier', () => {
        const r = { ...baseReceipt(), linkedTransactionId: 'txn-stale' };
        const out = buildTransferredReceipt(r, { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, note: '  Mauvaise unité  ', now: NOW });
        assert.equal('linkedTransactionId' in out, false);
        assert.equal(out.id, 'rcpt-1');
        assert.equal(out.url, r.url);
        assert.equal(out.extractedAmount, 42.5);
        assert.equal(out.expenseType, 'REIMBURSEMENT');
        assert.deepEqual(out.transferRequest, {
            fromComptaId: 'c-louv',
            fromComptaName: 'Louveteaux 26-27',
            toComptaId: 'c-pio',
            toComptaName: 'Pionnier 26-27',
            requestedByUid: 'u-caissier',
            requestedByName: 'Marc Caissier',
            requestedByEmail: 'marc@asso.ch',
            requestedAt: NOW,
            status: 'PENDING_ACCEPTANCE',
            isReturn: false,
            note: 'Mauvaise unité'
        });
        assert.equal(out.transferHistory.length, 1);
        assert.deepEqual(out.transferHistory[0], out.transferRequest);
        assert.equal(r.linkedTransactionId, 'txn-stale', "l'objet source ne doit pas être muté");
    });

    it('buildAcceptedReceipt passe le statut à ACCEPTED et met à jour la dernière entrée d’historique', () => {
        const transferred = buildTransferredReceipt(baseReceipt(), { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, now: NOW });
        const accepted = buildAcceptedReceipt(transferred, { uid: 'u-pio', name: 'Julie' }, NOW + 1000);
        assert.equal(accepted.transferRequest.status, 'ACCEPTED');
        assert.equal(accepted.transferRequest.acceptedAt, NOW + 1000);
        assert.equal(accepted.transferRequest.acceptedByUid, 'u-pio');
        assert.equal(accepted.transferRequest.acceptedByName, 'Julie');
        assert.equal(accepted.transferHistory.length, 1);
        assert.equal(accepted.transferHistory[0].status, 'ACCEPTED');
        assert.equal(transferred.transferRequest.status, 'PENDING_ACCEPTANCE', 'immutabilité');
    });

    it('isPendingIncomingTransfer détecte une pièce en attente dans la compta cible', () => {
        const transferred = buildTransferredReceipt(baseReceipt(), { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, now: NOW });
        assert.equal(isPendingIncomingTransfer(transferred, 'c-pio'), true);
    });

    it('les chemins Firestore respectent organizations/{org}/comptabilites/{compta}/…', () => {
        assert.equal(receiptDocPath('o', 'c', 'r').join('/'), 'organizations/o/comptabilites/c/receipts/r');
        assert.equal(transactionDocPath('o', 'c', 't').join('/'), 'organizations/o/comptabilites/c/transactions/t');
        assert.equal(comptaDocPath('o', 'c').join('/'), 'organizations/o/comptabilites/c');
    });
});

// ===========================================================================
// UNIT — CAS NÉGATIFS
// ===========================================================================
describe('WEB-03 — Unit : cas négatifs', () => {
    it('canTransferReceipt refuse viewer, vérificateur, uploader, inconnu et non-string', () => {
        for (const role of ['viewer', 'verificateur', 'uploader', 'member', '', null, undefined, 42]) {
            assert.equal(canTransferReceipt(role), false, `rôle ${String(role)}`);
        }
    });

    it('refuse une pièce absente ou sans id', () => {
        assert.equal(validateReceiptTransfer(validInput({ receipt: null })), 'Pièce justificative invalide.');
        assert.equal(validateReceiptTransfer(validInput({ receipt: { id: '' } })), 'Pièce justificative invalide.');
    });

    it('refuse une compta source inconnue', () => {
        assert.equal(validateReceiptTransfer(validInput({ fromComptaId: '' })), 'Comptabilité source inconnue.');
    });

    it('refuse une cible absente', () => {
        assert.equal(validateReceiptTransfer(validInput({ targetCompta: null })), 'Veuillez choisir une comptabilité cible.');
        assert.equal(validateReceiptTransfer(validInput({ targetCompta: { id: '' } })), 'Veuillez choisir une comptabilité cible.');
    });

    it('refuse un transfert vers la même comptabilité', () => {
        assert.equal(
            validateReceiptTransfer(validInput({ targetCompta: louveteaux })),
            'La comptabilité cible doit être différente de la comptabilité actuelle.'
        );
    });

    it('refuse une comptabilité cible archivée', () => {
        assert.equal(
            validateReceiptTransfer(validInput({ targetCompta: archived })),
            'Impossible de transférer vers une comptabilité archivée.'
        );
    });

    it('refuse une pièce liée à une transaction existante', () => {
        const linked = { ...baseReceipt(), linkedTransactionId: 'txn-1' };
        assert.equal(
            validateReceiptTransfer(validInput({ receipt: linked })),
            'Cette pièce est liée à une transaction : déliez-la avant de la transférer.'
        );
    });

    it('refuse un utilisateur non identifié', () => {
        assert.equal(validateReceiptTransfer(validInput({ requestedByUid: '' })), 'Utilisateur non identifié.');
        assert.equal(validateReceiptTransfer(validInput({ requestedByUid: '   ' })), 'Utilisateur non identifié.');
        assert.equal(validateReceiptTransfer(validInput({ requestedByUid: undefined })), 'Utilisateur non identifié.');
    });

    it('buildAcceptedReceipt lève une erreur si la pièce n’a pas été transférée ou est déjà acceptée', () => {
        assert.throws(() => buildAcceptedReceipt(baseReceipt(), actor, NOW), /n'a pas été transférée/);
        const transferred = buildTransferredReceipt(baseReceipt(), { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, now: NOW });
        const accepted = buildAcceptedReceipt(transferred, actor, NOW);
        assert.throws(() => buildAcceptedReceipt(accepted, actor, NOW), /déjà été confirmée/);
    });

    it('isPendingIncomingTransfer est faux hors compta cible, après acceptation ou sans transfert', () => {
        const transferred = buildTransferredReceipt(baseReceipt(), { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, now: NOW });
        assert.equal(isPendingIncomingTransfer(transferred, 'c-louv'), false);
        assert.equal(isPendingIncomingTransfer(transferred, ''), false);
        assert.equal(isPendingIncomingTransfer(transferred, null), false);
        assert.equal(isPendingIncomingTransfer(buildAcceptedReceipt(transferred, actor, NOW), 'c-pio'), false);
        assert.equal(isPendingIncomingTransfer(baseReceipt(), 'c-pio'), false);
        assert.equal(isPendingIncomingTransfer(null, 'c-pio'), false);
    });
});

// ===========================================================================
// UNIT — VALEURS LIMITES
// ===========================================================================
describe('WEB-03 — Unit : valeurs limites', () => {
    it(`note de ${MAX_TRANSFER_NOTE_LENGTH} caractères acceptée, ${MAX_TRANSFER_NOTE_LENGTH + 1} refusée`, () => {
        assert.equal(MAX_TRANSFER_NOTE_LENGTH, 500);
        assert.equal(validateReceiptTransfer(validInput({ note: 'a'.repeat(500) })), null);
        assert.equal(
            validateReceiptTransfer(validInput({ note: 'a'.repeat(501) })),
            'Le commentaire ne peut pas dépasser 500 caractères.'
        );
    });

    it('les espaces autour de la note ne comptent pas dans la limite', () => {
        assert.equal(validateReceiptTransfer(validInput({ note: `  ${'a'.repeat(500)}  ` })), null);
    });

    it(`historique borné à ${MAX_TRANSFER_HISTORY} entrées (les plus récentes conservées)`, () => {
        assert.equal(MAX_TRANSFER_HISTORY, 20);
        const history19 = Array.from({ length: 19 }, (_, i) => ({ requestedAt: i }));
        const out20 = buildTransferredReceipt({ ...baseReceipt(), transferHistory: history19 }, { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, now: NOW });
        assert.equal(out20.transferHistory.length, 20);
        assert.equal(out20.transferHistory[0].requestedAt, 0);

        const history20 = Array.from({ length: 20 }, (_, i) => ({ requestedAt: i }));
        const out21 = buildTransferredReceipt({ ...baseReceipt(), transferHistory: history20 }, { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, now: NOW });
        assert.equal(out21.transferHistory.length, 20);
        assert.equal(out21.transferHistory[0].requestedAt, 1, 'la plus ancienne entrée est retirée');
        assert.equal(out21.transferHistory[19].requestedAt, NOW);
    });

    it('montant 0 affiché CHF 0.00, montants négatifs et décimaux arrondis', () => {
        assert.equal(formatReceiptAmountChf(0), 'CHF 0.00');
        assert.equal(formatReceiptAmountChf(-12.345), 'CHF -12.35');
        assert.equal(formatReceiptAmountChf(0.005), 'CHF 0.01');
    });

    it('montant non fini / absent affiché CHF ?', () => {
        for (const v of [undefined, null, NaN, Infinity, -Infinity, '42']) {
            assert.equal(formatReceiptAmountChf(v), 'CHF ?');
        }
    });

    it('formats de date : ISO, ISO avec heure, DD.MM.YYYY, DD.MM.YY, vide, inconnu', () => {
        assert.equal(formatReceiptDateFr('2026-01-05'), '05/01/2026');
        assert.equal(formatReceiptDateFr('2026-01-05T10:00:00Z'), '05/01/2026');
        assert.equal(formatReceiptDateFr('05.01.2026'), '05/01/2026');
        assert.equal(formatReceiptDateFr('05.01.26'), '05/01/2026');
        assert.equal(formatReceiptDateFr('  2026-12-31  '), '31/12/2026');
        assert.equal(formatReceiptDateFr(''), 'date inconnue');
        assert.equal(formatReceiptDateFr('   '), 'date inconnue');
        assert.equal(formatReceiptDateFr(undefined), 'date inconnue');
        assert.equal(formatReceiptDateFr('hier'), 'hier');
        assert.equal(formatReceiptDateFr('5.1.26'), '5.1.26');
    });

    it('getEligibleTargetComptas avec liste vide, null ou une seule compta (la source)', () => {
        assert.deepEqual(getEligibleTargetComptas([], 'x'), []);
        assert.deepEqual(getEligibleTargetComptas(null, 'x'), []);
        assert.deepEqual(getEligibleTargetComptas(undefined, 'x'), []);
        assert.deepEqual(getEligibleTargetComptas([louveteaux], louveteaux.id), []);
    });
});

// ===========================================================================
// UNIT — CAS PARTICULIERS
// ===========================================================================
describe('WEB-03 — Unit : cas particuliers', () => {
    it('lien vers une transaction supprimée (hasActiveLink=false) : transfert autorisé', () => {
        const linked = { ...baseReceipt(), linkedTransactionId: 'txn-deleted' };
        assert.equal(validateReceiptTransfer(validInput({ receipt: linked, hasActiveLink: false })), null);
    });

    it('hasActiveLink=true force le refus même sans linkedTransactionId', () => {
        assert.match(validateReceiptTransfer(validInput({ hasActiveLink: true })), /liée à une transaction/);
    });

    it('isSafeDocId refuse les identifiants contenant « / » (injection de chemin)', () => {
        assert.equal(isSafeDocId('abc'), true);
        assert.equal(isSafeDocId('a/b'), false);
        assert.equal(isSafeDocId('   '), false);
        assert.equal(isSafeDocId(null), false);
        assert.equal(validateReceiptTransfer(validInput({ receipt: { id: '../x/y' } })), 'Pièce justificative invalide.');
        assert.equal(validateReceiptTransfer(validInput({ targetCompta: { id: 'c/evil' } })), 'Veuillez choisir une comptabilité cible.');
    });

    it('normalizeTransferNote : trim, non-string → chaîne vide', () => {
        assert.equal(normalizeTransferNote('  hello  '), 'hello');
        assert.equal(normalizeTransferNote(undefined), '');
        assert.equal(normalizeTransferNote(null), '');
        assert.equal(normalizeTransferNote(12), '');
    });

    it('note vide ou espaces : aucun champ note, aucun undefined (compatible Firestore)', () => {
        const out = buildTransferredReceipt(baseReceipt(), { fromCompta: louveteaux, toCompta: pionnier, requestedBy: { uid: 'u' }, note: '   ', now: NOW });
        assert.equal('note' in out.transferRequest, false);
        assert.equal('requestedByEmail' in out.transferRequest, false);
        assert.equal(out.transferRequest.requestedByName, 'Utilisateur');
        assert.equal(JSON.stringify(out).includes('undefined'), false);
        for (const [k, v] of Object.entries(out.transferRequest)) assert.notEqual(v, undefined, k);
    });

    it('fallbacks : nom de compta absent → id ; nom utilisateur absent → email', () => {
        const out = buildTransferredReceipt(baseReceipt(), {
            fromCompta: { id: 'c-a' }, toCompta: { id: 'c-b', name: '' },
            requestedBy: { uid: 'u', email: 'x@y.ch' }, now: NOW, isReturn: true
        });
        assert.equal(out.transferRequest.fromComptaName, 'c-a');
        assert.equal(out.transferRequest.toComptaName, 'c-b');
        assert.equal(out.transferRequest.requestedByName, 'x@y.ch');
        assert.equal(out.transferRequest.isReturn, true);
    });

    it('noms avec accents / guillemets conservés dans le message', () => {
        assert.match(buildTransferConfirmationMessage({ extractedAmount: 1 }, 'Éclaireurs « Été »'), /« Éclaireurs « Été » » \?$/);
        assert.match(buildTransferConfirmationMessage({}, 'X'), /\(CHF \? du date inconnue\)/);
    });

    it('getEligibleTargetComptas ignore les entrées nulles et trie sur l’id si le nom manque', () => {
        const res = getEligibleTargetComptas([null, { id: 'b' }, { id: 'a' }, { id: '' }, undefined], 'z');
        assert.deepEqual(res.map(c => c.id), ['a', 'b']);
    });

    it('buildAcceptedReceipt ajoute une entrée si l’historique est absent ou désynchronisé', () => {
        const transferred = buildTransferredReceipt(baseReceipt(), { fromCompta: louveteaux, toCompta: pionnier, requestedBy: actor, now: NOW });
        const noHistory = { ...transferred, transferHistory: undefined };
        assert.equal(buildAcceptedReceipt(noHistory, actor, NOW).transferHistory.length, 1);
        const desync = { ...transferred, transferHistory: [{ requestedAt: 1, status: 'ACCEPTED' }] };
        const out = buildAcceptedReceipt(desync, { uid: 'u', email: 'e@x.ch' }, NOW);
        assert.equal(out.transferHistory.length, 2);
        assert.equal(out.transferHistory[0].requestedAt, 1);
        assert.equal(out.transferRequest.acceptedByName, 'e@x.ch');
        assert.equal(buildAcceptedReceipt(transferred, { uid: 'u' }, NOW).transferRequest.acceptedByName, 'Utilisateur');
    });
});

// ===========================================================================
// INTÉGRATION — performReceiptTransfer sur un Firestore transactionnel en mémoire
// ===========================================================================
describe('WEB-03 — Intégration : transfert transactionnel', () => {
    const srcKey = receiptDocPath('org1', 'c-louv', 'rcpt-1').join('/');
    const dstKey = receiptDocPath('org1', 'c-pio', 'rcpt-1').join('/');

    it('POSITIF : la pièce disparaît de la source et apparaît dans la cible avec traçabilité', async () => {
        const db = seedDb();
        const result = await db.run(tx => performReceiptTransfer(tx, transferParams()));
        assert.equal(db.store.has(srcKey), false);
        assert.equal(db.store.has(dstKey), true);
        const stored = db.store.get(dstKey);
        assert.equal(stored.transferRequest.fromComptaName, 'Louveteaux 26-27');
        assert.equal(stored.transferRequest.toComptaName, 'Pionnier 26-27');
        assert.equal(stored.transferRequest.requestedByName, 'Marc Caissier');
        assert.equal(stored.transferRequest.note, 'Envoyée par erreur');
        assert.equal(stored.transferRequest.status, 'PENDING_ACCEPTANCE');
        assert.equal(stored.url, baseReceipt().url, "l'URL Storage reste inchangée");
        assert.deepEqual(result, stored);
    });

    it('POSITIF : cycle complet transfert → renvoi → transfert puis confirmation (historique conservé)', async () => {
        const db = seedDb();
        await db.run(tx => performReceiptTransfer(tx, transferParams()));
        await db.run(tx => performReceiptTransfer(tx, transferParams({ fromComptaId: 'c-pio', toComptaId: 'c-louv', isReturn: true, note: '', now: NOW + 1 })));
        assert.equal(db.store.has(srcKey), true);
        assert.equal(db.store.has(dstKey), false);
        const back = db.store.get(srcKey);
        assert.equal(back.transferRequest.isReturn, true);
        assert.equal(back.transferRequest.fromComptaId, 'c-pio');
        assert.equal(back.transferHistory.length, 2);

        await db.run(tx => performReceiptTransfer(tx, transferParams({ now: NOW + 2 })));
        const accepted = buildAcceptedReceipt(db.store.get(dstKey), { uid: 'u-pio', name: 'Julie' }, NOW + 3);
        db.store.set(dstKey, accepted);
        assert.equal(db.store.get(dstKey).transferRequest.status, 'ACCEPTED');
        assert.equal(db.store.get(dstKey).transferHistory.length, 3);
        assert.equal(isPendingIncomingTransfer(db.store.get(dstKey), 'c-pio'), false);
    });

    it('POSITIF : lien vers une transaction supprimée → transfert autorisé et lien retiré', async () => {
        const db = seedDb({ linkedTransactionId: 'txn-deleted' });
        await db.run(tx => performReceiptTransfer(tx, transferParams()));
        assert.equal('linkedTransactionId' in db.store.get(dstKey), false);
    });

    const expectRollback = async (db, params, pattern) => {
        const before = JSON.stringify([...db.store.entries()]);
        await assert.rejects(() => db.run(tx => performReceiptTransfer(tx, params)), pattern);
        assert.equal(JSON.stringify([...db.store.entries()]), before, 'aucune écriture ne doit être appliquée');
    };

    it('NÉGATIF : pièce liée à une transaction existante → refus et aucune écriture', async () => {
        const db = seedDb({ linkedTransactionId: 'txn-1' }, {
            [transactionDocPath('org1', 'c-louv', 'txn-1').join('/')]: { amount: -42.5 }
        });
        await expectRollback(db, transferParams(), /déliez-la/);
    });

    it('NÉGATIF : pièce déjà transférée / supprimée (double clic concurrent)', async () => {
        const db = seedDb();
        await db.run(tx => performReceiptTransfer(tx, transferParams()));
        await expectRollback(db, transferParams(), /n'existe plus/);
    });

    it('NÉGATIF : comptabilité cible introuvable ou archivée', async () => {
        await expectRollback(seedDb(), transferParams({ toComptaId: 'c-ghost' }), /introuvable/);
        await expectRollback(seedDb(), transferParams({ toComptaId: 'c-old' }), /archivée/);
    });

    it('NÉGATIF : collision d’identifiant dans la cible', async () => {
        const db = seedDb({}, { [dstKey]: { id: 'rcpt-1', fileName: 'autre.pdf' } });
        await expectRollback(db, transferParams(), /existe déjà/);
    });

    it('NÉGATIF : même compta source et cible', async () => {
        await expectRollback(seedDb(), transferParams({ toComptaId: 'c-louv' }), /existe déjà|différente/);
    });

    it('NÉGATIF : identifiants invalides (vides ou avec « / »)', async () => {
        await expectRollback(seedDb(), transferParams({ orgId: '' }), /Organisation inconnue/);
        await expectRollback(seedDb(), transferParams({ receiptId: 'a/b' }), /Pièce justificative invalide/);
        await expectRollback(seedDb(), transferParams({ fromComptaId: '' }), /source inconnue/);
        await expectRollback(seedDb(), transferParams({ toComptaId: 'x/y' }), /comptabilité cible/);
    });

    it('NÉGATIF : utilisateur sans uid et note trop longue', async () => {
        await expectRollback(seedDb(), transferParams({ requestedBy: { uid: '' } }), /non identifié/);
        await expectRollback(seedDb(), transferParams({ requestedBy: undefined }), /non identifié/);
        await expectRollback(seedDb(), transferParams({ note: 'x'.repeat(501) }), /500 caractères/);
    });

    it('LIMITE : note de exactement 500 caractères acceptée de bout en bout', async () => {
        const db = seedDb();
        await db.run(tx => performReceiptTransfer(tx, transferParams({ note: 'x'.repeat(500) })));
        assert.equal(db.store.get(dstKey).transferRequest.note.length, 500);
    });

    it('PARTICULIER : compta source supprimée entre-temps → nom de repli = id', async () => {
        const db = seedDb();
        db.store.delete(comptaDocPath('org1', 'c-louv').join('/'));
        await db.run(tx => performReceiptTransfer(tx, transferParams()));
        assert.equal(db.store.get(dstKey).transferRequest.fromComptaName, 'c-louv');
    });

    it('PARTICULIER : la pièce est relue depuis la base (données fraîches, pas la copie UI)', async () => {
        const db = seedDb({ extractedAmount: 99.9 });
        const out = await db.run(tx => performReceiptTransfer(tx, transferParams()));
        assert.equal(out.extractedAmount, 99.9);
        assert.equal(out.id, 'rcpt-1');
    });
});
