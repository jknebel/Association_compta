/**
 * WEB-03 — Transfert d'une pièce justificative vers une autre comptabilité.
 *
 * Ce module ne contient AUCUNE dépendance runtime (ni Firebase, ni React) afin d'être
 * testable unitairement avec `node --test` et validé par mutation testing.
 * La persistance Firestore passe par l'interface `TransferTxAdapter`, implémentée
 * dans `organizationService.ts` au-dessus de `runTransaction` (atomicité garantie).
 */
import type { Receipt, ReceiptTransferRequest } from '../../types';

export const MAX_TRANSFER_NOTE_LENGTH = 500;
export const MAX_TRANSFER_HISTORY = 20;

export interface TransferActor {
    uid: string;
    name?: string | null;
    email?: string | null;
}

export interface TransferComptaRef {
    id: string;
    name?: string | null;
    isArchived?: boolean;
}

// ---------------------------------------------------------------------------
// Droits
// ---------------------------------------------------------------------------

/**
 * Seuls les caissiers (ou anciens « comptables »), les admins d'organisation et
 * les super-admins peuvent transférer une pièce. Lecteurs, vérificateurs et
 * déposants (uploader) ne le peuvent pas.
 */
export const canTransferReceipt = (
    role?: string | null,
    isOrgAdmin = false,
    isSuperAdmin = false
): boolean => {
    if (isSuperAdmin === true || isOrgAdmin === true) return true;
    if (typeof role !== 'string') return false;
    const norm = role.trim().toLowerCase();
    return norm === 'caissier' || norm === 'comptable' || norm === 'admin';
};

// ---------------------------------------------------------------------------
// Helpers d'affichage
// ---------------------------------------------------------------------------

export const formatReceiptAmountChf = (amount?: number | null): string => {
    if (typeof amount === 'number' && Number.isFinite(amount)) {
        return `CHF ${amount.toFixed(2)}`;
    }
    return 'CHF ?';
};

/** Formate une date ISO (YYYY-MM-DD) ou suisse (DD.MM.YY / DD.MM.YYYY) en JJ/MM/AAAA. */
export const formatReceiptDateFr = (value?: string | null): string => {
    if (typeof value !== 'string' || value.trim() === '') return 'date inconnue';
    const v = value.trim();
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    const dotted = v.match(/^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/);
    if (dotted) {
        const year = dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3];
        return `${dotted[1]}/${dotted[2]}/${year}`;
    }
    return v;
};

export const buildTransferConfirmationMessage = (
    receipt: Pick<Receipt, 'extractedAmount' | 'extractedDate'>,
    targetComptaName: string
): string => {
    const amount = formatReceiptAmountChf(receipt.extractedAmount);
    const date = formatReceiptDateFr(receipt.extractedDate);
    return `Êtes-vous sûr de vouloir transférer cette pièce justificative (${amount} du ${date}) vers la comptabilité « ${targetComptaName} » ?`;
};

// ---------------------------------------------------------------------------
// Sélection & validation
// ---------------------------------------------------------------------------

/** Comptabilités cibles possibles : actives, différentes de la source, triées par nom. */
export const getEligibleTargetComptas = <T extends TransferComptaRef>(
    comptas: T[] | null | undefined,
    fromComptaId: string
): T[] => {
    if (!Array.isArray(comptas)) return [];
    return comptas
        .filter(c => !!c && typeof c.id === 'string' && c.id !== '' && c.id !== fromComptaId && c.isArchived !== true)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'fr'));
};

export const normalizeTransferNote = (note?: string | null): string =>
    typeof note === 'string' ? note.trim() : '';

/** Identifiant Firestore sûr (non vide, sans « / »). */
export const isSafeDocId = (id?: string | null): boolean =>
    typeof id === 'string' && id.trim() !== '' && !id.includes('/');

export interface ValidateTransferInput {
    receipt: Pick<Receipt, 'id' | 'linkedTransactionId'> | null | undefined;
    fromComptaId: string | null | undefined;
    targetCompta: TransferComptaRef | null | undefined;
    requestedByUid: string | null | undefined;
    note?: string | null;
    /** true si la pièce est liée à une transaction qui existe encore. Par défaut : présence de linkedTransactionId. */
    hasActiveLink?: boolean;
}

/** Retourne un message d'erreur en français, ou `null` si le transfert est autorisé. */
export const validateReceiptTransfer = (input: ValidateTransferInput): string | null => {
    const { receipt, fromComptaId, targetCompta, requestedByUid, note } = input;
    if (!receipt || !isSafeDocId(receipt.id)) return 'Pièce justificative invalide.';
    if (!isSafeDocId(fromComptaId)) return 'Comptabilité source inconnue.';
    if (!targetCompta || !isSafeDocId(targetCompta.id)) return 'Veuillez choisir une comptabilité cible.';
    if (targetCompta.id === fromComptaId) return 'La comptabilité cible doit être différente de la comptabilité actuelle.';
    if (targetCompta.isArchived === true) return 'Impossible de transférer vers une comptabilité archivée.';
    const hasActiveLink = input.hasActiveLink ?? Boolean(receipt.linkedTransactionId);
    if (hasActiveLink) return 'Cette pièce est liée à une transaction : déliez-la avant de la transférer.';
    if (typeof requestedByUid !== 'string' || requestedByUid.trim() === '') return 'Utilisateur non identifié.';
    if (normalizeTransferNote(note).length > MAX_TRANSFER_NOTE_LENGTH) {
        return `Le commentaire ne peut pas dépasser ${MAX_TRANSFER_NOTE_LENGTH} caractères.`;
    }
    return null;
};

// ---------------------------------------------------------------------------
// Construction des documents
// ---------------------------------------------------------------------------

export interface BuildTransferParams {
    fromCompta: { id: string; name?: string | null };
    toCompta: { id: string; name?: string | null };
    requestedBy: TransferActor;
    note?: string | null;
    isReturn?: boolean;
    now: number;
}

/**
 * Construit la pièce telle qu'elle sera écrite dans la comptabilité cible :
 * - lien de transaction supprimé (il n'a pas de sens dans une autre comptabilité),
 * - `transferRequest` en attente de confirmation de réception,
 * - historique d'audit `transferHistory` borné à MAX_TRANSFER_HISTORY entrées.
 * Aucun champ `undefined` n'est produit (compatible Firestore).
 */
export const buildTransferredReceipt = (receipt: Receipt, params: BuildTransferParams): Receipt => {
    const cleanNote = normalizeTransferNote(params.note);
    const request: ReceiptTransferRequest = {
        fromComptaId: params.fromCompta.id,
        fromComptaName: params.fromCompta.name || params.fromCompta.id,
        toComptaId: params.toCompta.id,
        toComptaName: params.toCompta.name || params.toCompta.id,
        requestedByUid: params.requestedBy.uid,
        requestedByName: params.requestedBy.name || params.requestedBy.email || 'Utilisateur',
        requestedAt: params.now,
        status: 'PENDING_ACCEPTANCE',
        isReturn: params.isReturn === true
    };
    if (params.requestedBy.email) request.requestedByEmail = params.requestedBy.email;
    if (cleanNote) request.note = cleanNote;

    const { linkedTransactionId: _droppedLink, ...rest } = receipt;
    const history = [...(Array.isArray(receipt.transferHistory) ? receipt.transferHistory : []), request]
        .slice(-MAX_TRANSFER_HISTORY);

    return { ...rest, transferRequest: request, transferHistory: history };
};

/** Marque la réception d'une pièce transférée comme confirmée par la comptabilité cible. */
export const buildAcceptedReceipt = (receipt: Receipt, acceptedBy: TransferActor, now: number): Receipt => {
    const current = receipt.transferRequest;
    if (!current) throw new Error("Cette pièce n'a pas été transférée.");
    if (current.status !== 'PENDING_ACCEPTANCE') throw new Error('La réception de cette pièce a déjà été confirmée.');
    const accepted: ReceiptTransferRequest = {
        ...current,
        status: 'ACCEPTED',
        acceptedAt: now,
        acceptedByUid: acceptedBy.uid,
        acceptedByName: acceptedBy.name || acceptedBy.email || 'Utilisateur'
    };
    const history = Array.isArray(receipt.transferHistory) ? [...receipt.transferHistory] : [];
    const lastIdx = history.length - 1;
    if (lastIdx >= 0 && history[lastIdx].requestedAt === current.requestedAt) {
        history[lastIdx] = accepted;
    } else {
        history.push(accepted);
    }
    return { ...receipt, transferRequest: accepted, transferHistory: history.slice(-MAX_TRANSFER_HISTORY) };
};

export const isPendingIncomingTransfer = (
    receipt: Pick<Receipt, 'transferRequest'> | null | undefined,
    currentComptaId: string | null | undefined
): boolean => {
    const tr = receipt?.transferRequest;
    return !!tr && tr.status === 'PENDING_ACCEPTANCE' && !!currentComptaId && tr.toComptaId === currentComptaId;
};

// ---------------------------------------------------------------------------
// Exécution transactionnelle (indépendante de Firebase)
// ---------------------------------------------------------------------------

export interface TransferTxAdapter {
    get(path: string[]): Promise<{ exists: boolean; data?: any }>;
    set(path: string[], data: any): void;
    delete(path: string[]): void;
}

export const comptaDocPath = (orgId: string, comptaId: string): string[] =>
    ['organizations', orgId, 'comptabilites', comptaId];

export const receiptDocPath = (orgId: string, comptaId: string, receiptId: string): string[] =>
    [...comptaDocPath(orgId, comptaId), 'receipts', receiptId];

export const transactionDocPath = (orgId: string, comptaId: string, transactionId: string): string[] =>
    [...comptaDocPath(orgId, comptaId), 'transactions', transactionId];

export interface PerformTransferParams {
    orgId: string;
    fromComptaId: string;
    toComptaId: string;
    receiptId: string;
    requestedBy: TransferActor;
    note?: string | null;
    isReturn?: boolean;
    now: number;
}

/**
 * Déplace `comptabilites/{from}/receipts/{id}` vers `comptabilites/{to}/receipts/{id}`.
 * Toutes les lectures sont faites AVANT les écritures (contrainte des transactions Firestore),
 * et la pièce est relue depuis la base pour éviter de travailler sur une copie périmée.
 */
export const performReceiptTransfer = async (tx: TransferTxAdapter, params: PerformTransferParams): Promise<Receipt> => {
    const { orgId, fromComptaId, toComptaId, receiptId } = params;
    if (!isSafeDocId(orgId)) throw new Error('Organisation inconnue.');
    if (!isSafeDocId(receiptId)) throw new Error('Pièce justificative invalide.');
    if (!isSafeDocId(fromComptaId)) throw new Error('Comptabilité source inconnue.');
    if (!isSafeDocId(toComptaId)) throw new Error('Veuillez choisir une comptabilité cible.');

    const sourcePath = receiptDocPath(orgId, fromComptaId, receiptId);
    const targetPath = receiptDocPath(orgId, toComptaId, receiptId);

    const sourceSnap = await tx.get(sourcePath);
    if (!sourceSnap.exists) {
        throw new Error("La pièce n'existe plus dans la comptabilité source (déjà transférée ou supprimée).");
    }
    const toComptaSnap = await tx.get(comptaDocPath(orgId, toComptaId));
    if (!toComptaSnap.exists) throw new Error('La comptabilité cible est introuvable.');
    const fromComptaSnap = await tx.get(comptaDocPath(orgId, fromComptaId));
    const targetSnap = await tx.get(targetPath);
    if (targetSnap.exists) throw new Error('Une pièce avec le même identifiant existe déjà dans la comptabilité cible.');

    const freshReceipt: Receipt = { ...(sourceSnap.data as Receipt), id: receiptId };
    let hasActiveLink = false;
    if (freshReceipt.linkedTransactionId) {
        const txnSnap = await tx.get(transactionDocPath(orgId, fromComptaId, freshReceipt.linkedTransactionId));
        hasActiveLink = txnSnap.exists;
    }

    const toCompta: TransferComptaRef = { ...(toComptaSnap.data || {}), id: toComptaId };
    const fromCompta = { id: fromComptaId, name: fromComptaSnap.exists ? fromComptaSnap.data?.name : undefined };

    const error = validateReceiptTransfer({
        receipt: freshReceipt,
        fromComptaId,
        targetCompta: toCompta,
        requestedByUid: params.requestedBy?.uid,
        note: params.note,
        hasActiveLink
    });
    if (error) throw new Error(error);

    const transferred = buildTransferredReceipt(freshReceipt, {
        fromCompta,
        toCompta,
        requestedBy: params.requestedBy,
        note: params.note,
        isReturn: params.isReturn,
        now: params.now
    });

    tx.set(targetPath, transferred);
    tx.delete(sourcePath);
    return transferred;
};
