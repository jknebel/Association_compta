import React, { useState, useRef, useEffect } from 'react';
import { Receipt, Transaction, TransactionStatus } from '../../types';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, Image as ImageIcon, Link2, Trash2, Calendar, Coins, ExternalLink, CreditCard, Wallet, User, ArrowRightLeft, Undo2, X } from 'lucide-react';
import { analyzeReceipt, processReceiptBackend } from '../services/geminiService';
import { uploadReceipt } from '../services/storageService';
import { formatDate } from '../services/formatUtils';
import { useComptaContext, useAuthContext, useOrgContext } from '../contexts/AppContext';
import { listComptabilites, transferReceiptToComptabilite } from '../services/organizationService';
import { findPotentialMatchesForReceipt } from '../services/reimbursementMatching';
import {
    MAX_TRANSFER_NOTE_LENGTH,
    canTransferReceipt,
    getEligibleTargetComptas,
    validateReceiptTransfer,
    buildTransferConfirmationMessage,
    buildAcceptedReceipt,
    isPendingIncomingTransfer
} from '../services/receiptTransfer';
import { OrgRole, type Comptabilite } from '../types/rbac';

interface ReceiptsViewProps {
    receipts: Receipt[];
    transactions: Transaction[];
    onAddReceipt: (receipt: Receipt) => void;
    onDeleteReceipt: (id: string) => void;
    onLinkReceipt: (receiptId: string, transactionId: string) => void;
    onUpdateReceipt?: (receipt: Receipt) => void;
}

// WEB-03 : état de la modale de transfert (sélection -> confirmation explicite)
interface TransferDialogState {
    receipt: Receipt;
    step: 'select' | 'confirm';
    targetId: string;
    note: string;
    isReturn: boolean;
}

export const ReceiptsView: React.FC<ReceiptsViewProps> = ({
    receipts,
    transactions,
    onAddReceipt,
    onDeleteReceipt,
    onLinkReceipt,
    onUpdateReceipt
}) => {
    const { comptaRole, selectedCompta } = useComptaContext();
    const { selectedOrg, orgRole } = useOrgContext();
    const { user, userProfile, isSuperAdmin } = useAuthContext();
    const isViewer = comptaRole === 'viewer';
    const canTransfer = !!selectedOrg && !!selectedCompta && !!user &&
        canTransferReceipt(comptaRole, orgRole === OrgRole.ADMIN, isSuperAdmin);
    const [isProcessing, setIsProcessing] = useState(false);
    const [dragActive, setDragActive] = useState(false);
    const [filterType, setFilterType] = useState<'ALL' | 'DEBIT_CARD' | 'REIMBURSEMENT'>('ALL');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- WEB-03 : transfert vers une autre comptabilité ---
    const [transferDialog, setTransferDialog] = useState<TransferDialogState | null>(null);
    const [orgComptas, setOrgComptas] = useState<Comptabilite[]>([]);
    const [comptasLoading, setComptasLoading] = useState(false);
    const [isTransferring, setIsTransferring] = useState(false);
    const [transferError, setTransferError] = useState<string | null>(null);
    const [transferNotice, setTransferNotice] = useState<string | null>(null);

    const currentActor = () => ({
        uid: user?.uid || '',
        name: userProfile?.displayName || user?.displayName || user?.email || 'Utilisateur',
        email: user?.email || undefined
    });

    useEffect(() => {
        if (!transferDialog || !selectedOrg) return;
        let cancelled = false;
        setComptasLoading(true);
        listComptabilites(selectedOrg.id)
            .then(list => { if (!cancelled) setOrgComptas(list); })
            .catch(err => { if (!cancelled) setTransferError(`Impossible de charger les comptabilités : ${err?.message || err}`); })
            .finally(() => { if (!cancelled) setComptasLoading(false); });
        return () => { cancelled = true; };
        // Recharger uniquement à l'ouverture de la modale
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transferDialog?.receipt.id, selectedOrg?.id]);

    useEffect(() => {
        if (!transferNotice) return;
        const t = setTimeout(() => setTransferNotice(null), 6000);
        return () => clearTimeout(t);
    }, [transferNotice]);

    const eligibleTargets = selectedCompta ? getEligibleTargetComptas(orgComptas, selectedCompta.id) : [];
    const dialogTarget = transferDialog ? eligibleTargets.find(c => c.id === transferDialog.targetId) || null : null;

    const openTransferDialog = (receipt: Receipt) => {
        setTransferError(null);
        setTransferDialog({ receipt, step: 'select', targetId: '', note: '', isReturn: false });
    };

    const openReturnDialog = (receipt: Receipt) => {
        const origin = receipt.transferRequest?.fromComptaId || '';
        setTransferError(null);
        setTransferDialog({ receipt, step: 'confirm', targetId: origin, note: '', isReturn: true });
    };

    const closeTransferDialog = () => {
        if (isTransferring) return;
        setTransferDialog(null);
        setTransferError(null);
    };

    const goToConfirmStep = () => {
        if (!transferDialog || !selectedCompta) return;
        const error = validateReceiptTransfer({
            receipt: transferDialog.receipt,
            fromComptaId: selectedCompta.id,
            targetCompta: dialogTarget,
            requestedByUid: user?.uid,
            note: transferDialog.note
        });
        if (error) { setTransferError(error); return; }
        setTransferError(null);
        setTransferDialog({ ...transferDialog, step: 'confirm' });
    };

    const executeTransfer = async () => {
        if (!transferDialog || !selectedOrg || !selectedCompta) return;
        const error = validateReceiptTransfer({
            receipt: transferDialog.receipt,
            fromComptaId: selectedCompta.id,
            targetCompta: dialogTarget,
            requestedByUid: user?.uid,
            note: transferDialog.note
        });
        if (error || !dialogTarget) { setTransferError(error || 'Veuillez choisir une comptabilité cible.'); return; }
        setIsTransferring(true);
        setTransferError(null);
        try {
            await transferReceiptToComptabilite(
                selectedOrg.id,
                selectedCompta.id,
                dialogTarget.id,
                transferDialog.receipt,
                currentActor(),
                transferDialog.note,
                { isReturn: transferDialog.isReturn }
            );
            setTransferNotice(
                transferDialog.isReturn
                    ? `Pièce renvoyée vers « ${dialogTarget.name} ».`
                    : `Pièce transférée vers « ${dialogTarget.name} ».`
            );
            setTransferDialog(null);
        } catch (e: any) {
            setTransferError(e?.message || 'Le transfert a échoué.');
        } finally {
            setIsTransferring(false);
        }
    };

    const handleAcceptTransfer = (receipt: Receipt) => {
        if (!canTransfer) return;
        try {
            const accepted = buildAcceptedReceipt(receipt, currentActor(), Date.now());
            if (onUpdateReceipt) onUpdateReceipt(accepted);
            else onAddReceipt(accepted);
            setTransferNotice(`Réception confirmée (pièce venant de « ${receipt.transferRequest?.fromComptaName} »).`);
        } catch (e: any) {
            setTransferNotice(e?.message || 'Impossible de confirmer la réception.');
        }
    };

    // Open receipt file (handles both URLs and base64 data URIs incl. PDFs)
    const openReceipt = (url: string, fileName: string) => {
        if (url.startsWith('data:')) {
            // Convert base64 data URI to blob and open in new tab
            try {
                const [header, b64] = url.split(',');
                const mimeMatch = header.match(/data:(.*?);/);
                const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
                const byteChars = atob(b64);
                const byteArray = new Uint8Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
                const blob = new Blob([byteArray], { type: mime });
                const blobUrl = URL.createObjectURL(blob);
                window.open(blobUrl, '_blank');
            } catch (e) {
                console.error('Failed to open data URI', e);
                window.open(url, '_blank');
            }
        } else {
            window.open(url, '_blank');
        }
    };

    // Filter out receipts that are already linked to APPROVED or ARCHIVED transactions
    const unlinkedReceipts = receipts.filter(r => {
        if (!r.linkedTransactionId) return true;
        const linkedTxn = transactions.find(t => t.id === r.linkedTransactionId);
        if (!linkedTxn) return true;
        return linkedTxn.status !== TransactionStatus.APPROVED && linkedTxn.status !== TransactionStatus.ARCHIVED;
    });

    const handleDrag = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFiles(Array.from(e.dataTransfer.files));
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            handleFiles(Array.from(e.target.files));
        }
    };

    const handleFiles = async (files: File[]) => {
        setIsProcessing(true);

        // 1 & 2: Deduplication
        const validFiles = files.filter(f => !receipts.some(r => r.fileName === f.name));
        const duplicates = files.length - validFiles.length;

        if (duplicates > 0) {
            console.log(`${duplicates} fichier(s) ignoré(s) car déjà existants.`);
        }

        // 3. Upload TOUS les fichiers valides en Storage D'ABORD
        const uploadedData = await Promise.all(validFiles.map(async (file) => {
            try {
                const url = await uploadReceipt(file);
                return { file, url, success: true };
            } catch (e) {
                console.error("Error uploading file", file.name, e);
                return { file, url: "", success: false };
            }
        }));

        const successfulUploads = uploadedData.filter(d => d.success);
        const errors = validFiles.length - successfulUploads.length;

        // Helper pour l'IA (convertir en Base64 localement pour aller plus vite)
        const toBase64 = (f: File): Promise<string> => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                reader.readAsDataURL(f);
            });
        };

        // 4. Appliquer la couche IA sur tous les fichiers une fois qu'ils sont tous dans le storage
        const analysisPromises = successfulUploads.map(async ({ file, url }) => {
            let analysis: any = {};
            let suggestedTransactionId: string | null = null;
            
            try {
                const base64ForGemini = await toBase64(file);
                const result = await processReceiptBackend(base64ForGemini, file.type, transactions);
                analysis = result.extracted;
                suggestedTransactionId = result.matchedTransactionId;
            } catch (err) {
                console.error("Backend receipt process failed for", file.name, err);
            }

            const newReceipt: Receipt = {
                id: `rcpt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                url: url,
                fileName: file.name,
                uploadDate: new Date().toISOString().split('T')[0],
                extractedDate: analysis?.date ?? null,
                extractedAmount: analysis?.amount ?? null,
                isAnalyzed: true,
                linkedTransactionId: null // On force à null pour ne PAS lier automatiquement et laisser l'utilisateur vérifier
            };

            onAddReceipt(newReceipt);
            return { hasSuggestion: !!suggestedTransactionId };
        });

        const aiResults = await Promise.all(analysisPromises);
        setIsProcessing(false);

        const analyzedCount = aiResults.length;

        // Bilan
        let message = `Bilan du traitement :\n`;
        message += `- Fichiers totaux : ${files.length}\n`;
        if (duplicates > 0) message += `- Ignorés (déjà existants) : ${duplicates}\n`;
        if (errors > 0) message += `- Erreurs d'envoi Storage : ${errors}\n`;
        message += `- Validés par l'IA : ${analyzedCount}\n`;
        message += `\nTous vos justificatifs sont maintenant dans la liste pour vérification manuelle.`;

        alert(message);
    };

    // --- MATCHING LOGIC (WEB-04 : Carte de débit J / J+1 vs Remboursement indépendant de la date) ---
    const findPotentialMatches = (receipt: Receipt) => {
        return findPotentialMatchesForReceipt(receipt, transactions);
    };

    const displayedReceipts = unlinkedReceipts.filter(r => {
        if (filterType === 'DEBIT_CARD') return r.expenseType === 'DEBIT_CARD';
        if (filterType === 'REIMBURSEMENT') return r.expenseType === 'REIMBURSEMENT';
        return true;
    });

    const debitCardCount = unlinkedReceipts.filter(r => r.expenseType === 'DEBIT_CARD').length;
    const reimbursementCount = unlinkedReceipts.filter(r => r.expenseType === 'REIMBURSEMENT').length;

    const handleToggleReimbursed = (receipt: Receipt) => {
        if (isViewer) return;
        const isCurrentlyReimbursed = receipt.reimbursementStatus === 'REIMBURSED';
        if (!isCurrentlyReimbursed) {
            const recipientText = receipt.submittedByName ? ` à ${receipt.submittedByName}` : '';
            const amountText = receipt.extractedAmount ? ` de CHF ${receipt.extractedAmount.toFixed(2)}` : '';
            if (!window.confirm(`Confirmer le remboursement${amountText}${recipientText} ?`)) return;
            const updated: Receipt = {
                ...receipt,
                reimbursementStatus: 'REIMBURSED',
                reimbursedAt: Date.now(),
                reimbursedByUid: user?.uid,
                reimbursedByName: userProfile?.displayName || user?.displayName || user?.email || 'Caissier'
            };
            if (onUpdateReceipt) onUpdateReceipt(updated);
            else onAddReceipt(updated);
        } else {
            if (!window.confirm('Annuler le statut remboursé et repasser cette demande en attente ?')) return;
            const updated: Receipt = {
                ...receipt,
                reimbursementStatus: 'PENDING',
                reimbursedAt: undefined,
                reimbursedByUid: undefined,
                reimbursedByName: undefined
            };
            if (onUpdateReceipt) onUpdateReceipt(updated);
            else onAddReceipt(updated);
        }
    };

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto md:h-full flex flex-col">
            <header className="mb-6 md:mb-8">
                <h2 className="text-xl sm:text-2xl font-bold text-slate-100 flex items-center gap-2">
                    <Upload className="text-blue-500" />
                    Pièces Comptables
                </h2>
                <p className="text-sm text-slate-400 mt-2">
                    {isViewer
                        ? "Consultation des factures et justificatifs enregistrés."
                        : "Déposez vos factures et reçus ici. L'IA tentera de les associer automatiquement à vos transactions existantes."}
                </p>
            </header>

            {/* UPLOAD AREA (Hidden for Viewer) */}
            {!isViewer && (
                <div
                    className={`border-2 border-dashed rounded-xl p-5 md:p-8 flex flex-col items-center justify-center transition-all mb-6 md:mb-8 ${dragActive ? 'border-blue-500 bg-blue-900/20' : 'border-slate-700 bg-slate-900 hover:border-slate-500'
                        }`}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={handleDrop}
                >
                    {isProcessing ? (
                        <div className="flex flex-col items-center gap-3">
                            <Loader2 className="animate-spin text-blue-500" size={32} />
                            <p className="text-slate-300">Analyse par IA en cours...</p>
                        </div>
                    ) : (
                        <>
                            <div className="bg-slate-800 p-3 md:p-4 rounded-full mb-3 md:mb-4">
                                <FileText size={28} className="text-slate-400" />
                            </div>
                            <h3 className="text-base md:text-lg font-medium text-slate-200 mb-1 md:mb-2 text-center">Glissez-déposez vos fichiers ici</h3>
                            <p className="text-xs md:text-sm text-slate-500 mb-4">PDF, JPG, PNG acceptés</p>
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors font-medium text-sm"
                            >
                                Sélectionner des fichiers
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept="image/*,application/pdf"
                                className="hidden"
                                onChange={handleChange}
                            />
                        </>
                    )}
                </div>
            )}

            {/* LIST OF RECEIPTS */}
            <div className="md:flex-1 md:overflow-y-auto">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                    <h3 className="text-lg font-bold text-slate-200 flex items-center gap-2">
                        <Link2 size={20} />
                        Pièces à traiter ({unlinkedReceipts.length})
                    </h3>

                    {/* Quick Filter Bar */}
                    <div className="flex flex-wrap items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => setFilterType('ALL')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                filterType === 'ALL'
                                    ? 'bg-blue-600 text-white shadow-sm'
                                    : 'bg-slate-800/90 text-slate-300 hover:bg-slate-800 hover:text-white border border-slate-700/60'
                            }`}
                        >
                            Toutes ({unlinkedReceipts.length})
                        </button>
                        <button
                            type="button"
                            onClick={() => setFilterType('DEBIT_CARD')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                                filterType === 'DEBIT_CARD'
                                    ? 'bg-blue-600 text-white shadow-sm'
                                    : 'bg-slate-800/90 text-blue-300 hover:bg-slate-800 hover:text-blue-200 border border-slate-700/60'
                            }`}
                        >
                            <CreditCard size={13} />
                            Carte ({debitCardCount})
                        </button>
                        <button
                            type="button"
                            onClick={() => setFilterType('REIMBURSEMENT')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                                filterType === 'REIMBURSEMENT'
                                    ? 'bg-amber-600 text-white shadow-sm'
                                    : 'bg-slate-800/90 text-amber-300 hover:bg-slate-800 hover:text-amber-200 border border-slate-700/60'
                            }`}
                        >
                            <Wallet size={13} />
                            Remboursements ({reimbursementCount})
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
                    {displayedReceipts.map(receipt => {
                        const matches = findPotentialMatches(receipt);
                        const hasMatch = matches.length > 0;

                        return (
                            <div key={receipt.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-sm">
                                {/* PREVIEW HEADER — Clickable to open file */}
                                <div
                                    className="h-32 bg-slate-950 relative group cursor-pointer"
                                    onClick={() => openReceipt(receipt.url, receipt.fileName)}
                                    title="Cliquer pour ouvrir le fichier"
                                >
                                    {receipt.url.startsWith('data:image') || receipt.fileName.match(/\.(jpg|jpeg|png)$/i) ? (
                                        <img src={receipt.url} alt="receipt" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" />
                                    ) : (
                                        <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 group-hover:text-blue-400 transition-colors">
                                            <FileText size={48} />
                                            <span className="text-xs mt-2 text-slate-500 group-hover:text-blue-300">Cliquer pour ouvrir</span>
                                        </div>
                                    )}
                                    <div className="absolute top-2 right-2 p-1.5 bg-black/50 group-hover:bg-blue-600/80 rounded text-white backdrop-blur-sm transition-colors">
                                        <ExternalLink size={14} />
                                    </div>
                                </div>

                                {/* INFO BODY */}
                                <div className="p-4 flex-1 flex flex-col">
                                    {/* WEB-03 : bandeau de pièce transférée (en attente de confirmation de réception) */}
                                    {isPendingIncomingTransfer(receipt, selectedCompta?.id) && receipt.transferRequest && (
                                        <div className="mb-3 p-2.5 rounded-lg bg-indigo-950/60 border border-indigo-700/60 text-xs">
                                            <div className="flex items-start gap-1.5 text-indigo-200">
                                                <ArrowRightLeft size={13} className="mt-0.5 shrink-0" />
                                                <span>
                                                    {receipt.transferRequest.isReturn ? 'Renvoyée' : 'Transférée'} depuis <strong>« {receipt.transferRequest.fromComptaName} »</strong> par <strong>{receipt.transferRequest.requestedByName}</strong>
                                                    <span className="text-indigo-300/70"> — {new Date(receipt.transferRequest.requestedAt).toLocaleDateString('fr-CH')}</span>
                                                </span>
                                            </div>
                                            {receipt.transferRequest.note && (
                                                <div className="mt-1.5 text-indigo-200/80 italic break-words">« {receipt.transferRequest.note} »</div>
                                            )}
                                            {canTransfer && (
                                                <div className="mt-2 flex gap-1.5">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleAcceptTransfer(receipt)}
                                                        className="flex-1 py-1.5 px-2 rounded text-[11px] font-semibold bg-emerald-600/25 hover:bg-emerald-600/40 text-emerald-200 border border-emerald-600/50 transition-colors flex items-center justify-center gap-1"
                                                    >
                                                        <CheckCircle size={12} /> Confirmer la réception
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => openReturnDialog(receipt)}
                                                        className="flex-1 py-1.5 px-2 rounded text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 transition-colors flex items-center justify-center gap-1"
                                                        title={`Renvoyer vers « ${receipt.transferRequest.fromComptaName} »`}
                                                    >
                                                        <Undo2 size={12} /> Renvoyer
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {receipt.transferRequest?.status === 'ACCEPTED' && receipt.transferRequest.toComptaId === selectedCompta?.id && (
                                        <div className="mb-2 text-[11px] text-slate-500 flex items-center gap-1" title={`Réception confirmée par ${receipt.transferRequest.acceptedByName || '—'}`}>
                                            <ArrowRightLeft size={11} /> Reçue de « {receipt.transferRequest.fromComptaName} »
                                        </div>
                                    )}

                                    {/* Expense Type & Merchant Badges */}
                                    <div className="flex flex-wrap items-center gap-1.5 mb-2">
                                        {receipt.expenseType === 'DEBIT_CARD' ? (
                                            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-blue-900/40 text-blue-300 border border-blue-700/50 flex items-center gap-1">
                                                <CreditCard size={12} /> 💳 Carte de débit
                                            </span>
                                        ) : receipt.expenseType === 'REIMBURSEMENT' ? (
                                            receipt.reimbursementStatus === 'REIMBURSED' ? (
                                                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 flex items-center gap-1">
                                                    <CheckCircle size={12} /> ✅ Remboursé
                                                </span>
                                            ) : (
                                                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-900/40 text-amber-300 border border-amber-700/50 flex items-center gap-1">
                                                    <Wallet size={12} /> 💶 À rembourser
                                                </span>
                                            )
                                        ) : null}
                                        {receipt.merchantName && (
                                            <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700 truncate max-w-[140px]" title={receipt.merchantName}>
                                                {receipt.merchantName}
                                            </span>
                                        )}
                                    </div>

                                    <div className="flex justify-between items-start mb-2">
                                        <span className="text-sm font-medium text-slate-200 truncate pr-2" title={receipt.fileName}>
                                            {receipt.fileName ? (receipt.fileName.includes('_') ? receipt.fileName.split('_').slice(1).join('_') : receipt.fileName) : "Sans nom"}
                                        </span>
                                        {!isViewer && (
                                            <button onClick={() => onDeleteReceipt(receipt.id)} className="text-slate-600 hover:text-rose-500">
                                                <Trash2 size={16} />
                                            </button>
                                        )}
                                    </div>

                                    {/* WEB-03 : transfert vers une autre comptabilité (pièces non liées uniquement) */}
                                    {canTransfer && !receipt.linkedTransactionId && (
                                        <button
                                            type="button"
                                            onClick={() => openTransferDialog(receipt)}
                                            className="mb-2 self-start text-[11px] font-medium text-indigo-300 hover:text-indigo-200 bg-indigo-950/40 hover:bg-indigo-900/50 border border-indigo-800/60 rounded px-2 py-1 transition-colors flex items-center gap-1"
                                            title="Cette pièce n'est pas au bon endroit ? Envoyez-la vers une autre comptabilité de l'association."
                                        >
                                            <ArrowRightLeft size={12} /> ↪️ Transférer vers une autre compta
                                        </button>
                                    )}

                                    {/* Submitter Info */}
                                    {(receipt.submittedByName || receipt.submittedByEmail) && (
                                        <div className="text-[11px] text-slate-400 flex items-center gap-1 mb-1 truncate" title={receipt.submittedByEmail}>
                                            <User size={11} className="text-slate-500 shrink-0" />
                                            <span className="truncate">Déposé par <strong className="text-slate-300">{receipt.submittedByName || receipt.submittedByEmail}</strong></span>
                                        </div>
                                    )}

                                    {/* Description / Motif */}
                                    {receipt.description && (
                                        <div className="text-xs text-slate-300 italic mb-2 bg-slate-950/60 p-1.5 rounded border border-slate-800/80" title={receipt.description}>
                                            « {receipt.description} »
                                        </div>
                                    )}

                                    {/* Reimbursement Details & Action */}
                                    {receipt.expenseType === 'REIMBURSEMENT' && (
                                        <div className="mb-2 p-2 rounded bg-slate-950/80 border border-amber-900/30 text-xs">
                                            <div className="flex justify-between items-center text-[11px] text-slate-400">
                                                <span>IBAN :</span>
                                                <span className="font-mono text-amber-300/90 select-all font-medium">{receipt.reimbursementIban || 'Non spécifié'}</span>
                                            </div>
                                            {receipt.reimbursementStatus === 'REIMBURSED' ? (
                                                <div className="mt-1.5 pt-1.5 border-t border-slate-800 flex items-center justify-between text-[11px] text-emerald-400">
                                                    <span>Payé {receipt.reimbursedByName ? `par ${receipt.reimbursedByName}` : ''}</span>
                                                    {!isViewer && (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleToggleReimbursed(receipt)}
                                                            className="text-[10px] text-slate-400 hover:text-rose-400 underline ml-2"
                                                            title="Annuler le statut remboursé"
                                                        >
                                                            Annuler
                                                        </button>
                                                    )}
                                                </div>
                                            ) : !isViewer && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleToggleReimbursed(receipt)}
                                                    className="mt-2 w-full py-1.5 px-2 rounded text-xs font-semibold bg-emerald-600/25 hover:bg-emerald-600/35 text-emerald-300 border border-emerald-600/50 transition-colors flex items-center justify-center gap-1.5 shadow-sm"
                                                >
                                                    <CheckCircle size={13} /> Marquer comme remboursé
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    <div className="flex gap-4 text-xs text-slate-400 mb-4">
                                        <div className="flex items-center gap-1">
                                            <Calendar size={12} />
                                            {formatDate(receipt.extractedDate)}
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Coins size={12} />
                                            {receipt.extractedAmount ? `${receipt.extractedAmount.toFixed(2)} CHF` : <span className="italic">?</span>}
                                        </div>
                                    </div>

                                    {/* MATCHING SECTION */}
                                    <div className="mt-auto pt-4 border-t border-slate-800">
                                        {receipt.linkedTransactionId && transactions.find(t => t.id === receipt.linkedTransactionId) ? (() => {
                                            const linkedTxn = transactions.find(t => t.id === receipt.linkedTransactionId)!;
                                            return (
                                                <div className="space-y-2">
                                                    <div className="text-xs text-blue-400 font-bold flex items-center gap-1">
                                                        <CheckCircle size={12} /> Lié (en attente de validation)
                                                    </div>
                                                    <div className="w-full text-left p-2 rounded bg-blue-900/10 border border-blue-900/30 text-xs">
                                                        <div className="text-slate-300 font-medium truncate" title={linkedTxn.description}>{linkedTxn.description}</div>
                                                        {linkedTxn.notes && (
                                                            <div className="text-blue-300/80 italic mt-0.5 truncate text-[10px]" title={linkedTxn.notes}>
                                                                {linkedTxn.notes}
                                                            </div>
                                                        )}
                                                        <div className="flex justify-between text-slate-500 mt-1">
                                                            <span>{formatDate(linkedTxn.date)}</span>
                                                            <span className="text-blue-400">CHF {linkedTxn.amount.toFixed(2)}</span>
                                                        </div>
                                                    </div>
                                                    <p className="text-[10px] text-slate-500 text-center mt-2 leading-tight">
                                                        Cette pièce disparaîtra d'ici une fois la transaction approuvée dans le journal.
                                                    </p>
                                                </div>
                                            );
                                        })() : hasMatch ? (
                                            <div className="space-y-2">
                                                <div className="text-xs text-emerald-400 font-bold flex items-center gap-1">
                                                    <CheckCircle size={12} /> Suggestion trouvée
                                                </div>
                                                {matches.slice(0, 2).map(m => (
                                                    <button
                                                        key={m.id}
                                                        disabled={isViewer}
                                                        onClick={() => {
                                                            if (isViewer) return;
                                                            if (window.confirm(`Lier ce justificatif à la transaction :\n\n"${m.description}"\n${m.date} — CHF ${m.amount.toFixed(2)}\n\nConfirmer ?`)) {
                                                                onLinkReceipt(receipt.id, m.id);
                                                            }
                                                        }}
                                                        className={`w-full text-left p-2 rounded bg-emerald-900/10 ${isViewer ? '' : 'hover:bg-emerald-900/20'} border border-emerald-900/30 text-xs transition-colors group block`}
                                                    >
                                                        <div className="text-slate-300 font-medium truncate" title={m.description}>{m.description}</div>
                                                        {m.notes && (
                                                            <div className="text-emerald-400/70 italic mt-0.5 truncate text-[10px]" title={m.notes}>
                                                                {m.notes}
                                                            </div>
                                                        )}
                                                        <div className="flex justify-between text-slate-500 mt-1">
                                                            <span>{formatDate(m.date)}</span>
                                                            <span className="group-hover:text-emerald-400">CHF {m.amount.toFixed(2)}</span>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="text-xs text-amber-500 flex items-center gap-1 bg-amber-900/10 p-2 rounded border border-amber-900/30">
                                                <AlertCircle size={12} /> Aucune correspondance évidente
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {unlinkedReceipts.length === 0 && !isProcessing && (
                    <div className="text-center py-12 text-slate-500">
                        Aucune pièce en attente.
                    </div>
                )}
                {unlinkedReceipts.length > 0 && displayedReceipts.length === 0 && !isProcessing && (
                    <div className="text-center py-12 text-slate-500">
                        Aucune pièce ne correspond au filtre sélectionné.
                    </div>
                )}
            </div>

            {/* WEB-03 : notification de transfert */}
            {transferNotice && (
                <div className="fixed bottom-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg bg-slate-900 border border-indigo-700 text-sm text-indigo-100 shadow-xl flex items-start gap-2">
                    <ArrowRightLeft size={16} className="mt-0.5 shrink-0 text-indigo-400" />
                    <span className="flex-1">{transferNotice}</span>
                    <button type="button" onClick={() => setTransferNotice(null)} className="text-slate-400 hover:text-white" aria-label="Fermer">
                        <X size={14} />
                    </button>
                </div>
            )}

            {/* WEB-03 : modale de transfert (étape 1 = choix, étape 2 = confirmation explicite) */}
            {transferDialog && (
                <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={closeTransferDialog}>
                    <div
                        role="dialog"
                        aria-modal="true"
                        className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-xl shadow-2xl"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
                            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                                {transferDialog.isReturn ? <Undo2 size={18} className="text-indigo-400" /> : <ArrowRightLeft size={18} className="text-indigo-400" />}
                                {transferDialog.isReturn ? 'Renvoyer la pièce' : 'Transférer vers une autre comptabilité'}
                            </h3>
                            <button type="button" onClick={closeTransferDialog} disabled={isTransferring} className="text-slate-400 hover:text-white disabled:opacity-40" aria-label="Fermer">
                                <X size={18} />
                            </button>
                        </div>

                        <div className="px-5 py-4 space-y-4 text-sm">
                            <div className="text-xs text-slate-400 bg-slate-950/60 border border-slate-800 rounded p-2">
                                <span className="text-slate-300 font-medium">{transferDialog.receipt.fileName || 'Pièce sans nom'}</span>
                                <span> — {transferDialog.receipt.extractedAmount ? `CHF ${transferDialog.receipt.extractedAmount.toFixed(2)}` : 'montant inconnu'}</span>
                                <span> — {formatDate(transferDialog.receipt.extractedDate)}</span>
                                <div className="mt-1">Comptabilité actuelle : <strong className="text-slate-300">« {selectedCompta?.name} »</strong></div>
                            </div>

                            {comptasLoading ? (
                                <div className="flex items-center gap-2 text-slate-400">
                                    <Loader2 size={16} className="animate-spin" /> Chargement des comptabilités…
                                </div>
                            ) : transferDialog.step === 'select' ? (
                                <>
                                    {eligibleTargets.length === 0 ? (
                                        <div className="text-amber-300 text-xs bg-amber-900/20 border border-amber-800/50 rounded p-2">
                                            Aucune autre comptabilité active dans cette organisation.
                                        </div>
                                    ) : (
                                        <label className="block">
                                            <span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Comptabilité cible</span>
                                            <select
                                                value={transferDialog.targetId}
                                                onChange={e => { setTransferError(null); setTransferDialog({ ...transferDialog, targetId: e.target.value }); }}
                                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500"
                                            >
                                                <option value="">— Choisir une comptabilité —</option>
                                                {eligibleTargets.map(c => (
                                                    <option key={c.id} value={c.id}>{c.name}</option>
                                                ))}
                                            </select>
                                        </label>
                                    )}
                                    <label className="block">
                                        <span className="block text-xs font-semibold text-slate-400 uppercase mb-1">Commentaire (optionnel)</span>
                                        <textarea
                                            value={transferDialog.note}
                                            maxLength={MAX_TRANSFER_NOTE_LENGTH}
                                            onChange={e => setTransferDialog({ ...transferDialog, note: e.target.value })}
                                            rows={3}
                                            placeholder="Ex. : Facture du camp Pionnier envoyée par erreur chez les Louveteaux"
                                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 text-sm focus:outline-none focus:border-indigo-500 resize-none"
                                        />
                                        <span className="block text-right text-[10px] text-slate-500">{transferDialog.note.length}/{MAX_TRANSFER_NOTE_LENGTH}</span>
                                    </label>
                                </>
                            ) : dialogTarget ? (
                                <div className="p-3 rounded-lg bg-amber-900/20 border border-amber-700/50 text-amber-100 text-sm leading-relaxed">
                                    <AlertCircle size={16} className="inline mr-1 -mt-0.5 text-amber-400" />
                                    {buildTransferConfirmationMessage(transferDialog.receipt, dialogTarget.name)}
                                    {transferDialog.note.trim() && (
                                        <div className="mt-2 text-xs text-amber-200/80 italic">Commentaire : « {transferDialog.note.trim()} »</div>
                                    )}
                                    <div className="mt-2 text-xs text-amber-200/70">
                                        La pièce disparaîtra de « {selectedCompta?.name} » et apparaîtra immédiatement dans « {dialogTarget.name} ».
                                    </div>
                                </div>
                            ) : (
                                <div className="text-rose-300 text-xs bg-rose-900/20 border border-rose-800/50 rounded p-2">
                                    {transferDialog.isReturn
                                        ? `La comptabilité d'origine « ${transferDialog.receipt.transferRequest?.fromComptaName || '?'} » n'est plus disponible (archivée ou supprimée).`
                                        : 'Veuillez choisir une comptabilité cible.'}
                                </div>
                            )}

                            {transferError && (
                                <div className="text-rose-300 text-xs bg-rose-900/20 border border-rose-800/50 rounded p-2 flex items-start gap-1.5">
                                    <AlertCircle size={14} className="mt-0.5 shrink-0" /> {transferError}
                                </div>
                            )}
                        </div>

                        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-800">
                            {transferDialog.step === 'confirm' && !transferDialog.isReturn ? (
                                <button
                                    type="button"
                                    onClick={() => { setTransferError(null); setTransferDialog({ ...transferDialog, step: 'select' }); }}
                                    disabled={isTransferring}
                                    className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40"
                                >
                                    Retour
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={closeTransferDialog}
                                    disabled={isTransferring}
                                    className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-40"
                                >
                                    Annuler
                                </button>
                            )}
                            {transferDialog.step === 'select' ? (
                                <button
                                    type="button"
                                    onClick={goToConfirmStep}
                                    disabled={comptasLoading || !transferDialog.targetId}
                                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    Continuer
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={executeTransfer}
                                    disabled={isTransferring || comptasLoading || !dialogTarget}
                                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                                >
                                    {isTransferring && <Loader2 size={14} className="animate-spin" />}
                                    {transferDialog.isReturn ? 'Oui, renvoyer' : 'Oui, transférer'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
