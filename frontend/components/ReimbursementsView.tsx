import React, { useState, useMemo } from 'react';
import { Receipt, Transaction } from '../../types';
import {
  CheckSquare,
  Square,
  Search,
  Copy,
  Check,
  Mail,
  User as UserIcon,
  Calendar,
  CreditCard,
  Link as LinkIcon,
  Eye,
  FileText,
  X,
  RotateCcw,
  Wallet,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { useComptaContext, useAuthContext, useOrgContext } from '../contexts/AppContext';
import { formatDate } from '../services/formatUtils';
import {
  splitSubmitterIdentity,
  findPotentialMatchesForReceipt,
  toggleReceiptReimbursed,
  filterReimbursementReceipts,
  computeReimbursementStats,
} from '../services/reimbursementMatching';

interface ReimbursementsViewProps {
  receipts: Receipt[];
  transactions: Transaction[];
  onUpdateReceipt?: (receipt: Receipt) => void;
  onLinkReceipt: (receiptId: string, transactionId: string) => void;
}

export const ReimbursementsView: React.FC<ReimbursementsViewProps> = ({
  receipts,
  transactions,
  onUpdateReceipt,
  onLinkReceipt,
}) => {
  const { user, userProfile, isSuperAdmin } = useAuthContext();
  const { orgRole } = useOrgContext();
  const { comptaRole } = useComptaContext();
  const isCaissier =
    comptaRole === 'caissier' ||
    comptaRole === 'comptable' ||
    comptaRole === 'admin' ||
    orgRole === 'admin' ||
    isSuperAdmin;
  const isViewer = !isCaissier;

  const stats = useMemo(() => computeReimbursementStats(receipts), [receipts]);

  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'REIMBURSED' | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedIbanId, setCopiedIbanId] = useState<string | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);

  const filteredReimbursements = useMemo(
    () => filterReimbursementReceipts(receipts, statusFilter, searchQuery),
    [receipts, statusFilter, searchQuery]
  );

  const handleToggleBiffer = (receipt: Receipt) => {
    if (isViewer || !onUpdateReceipt) return;
    const actor = {
      uid: user?.uid || 'local-caissier',
      name:
        userProfile?.displayName ||
        user?.displayName ||
        user?.email ||
        'Caissier',
    };
    const updated = toggleReceiptReimbursed(receipt, actor);
    onUpdateReceipt(updated);
  };

  const handleCopyIban = async (id: string, iban: string) => {
    try {
      await navigator.clipboard.writeText(iban.replace(/\s+/g, ''));
      setCopiedIbanId(id);
      setTimeout(() => {
        setCopiedIbanId((prev) => (prev === id ? null : prev));
      }, 2000);
    } catch (e) {
      console.error('Copy IBAN failed', e);
    }
  };

  const isPdfReceipt = (r: Receipt) =>
    r.mimeType === 'application/pdf' ||
    r.fileName?.toLowerCase().endsWith('.pdf') ||
    r.url?.toLowerCase().includes('.pdf') ||
    r.url?.startsWith('data:application/pdf');

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-100 flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-amber-950/60 border border-amber-700/50 text-amber-300">
              💶
            </span>
            Gestion des Remboursements
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Suivez les justificatifs marqués « À rembourser », vérifiez le nom, prénom, e-mail et IBAN du membre, et biffez les remboursements effectués.
          </p>
        </div>
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 border border-amber-800/50 rounded-xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
              <Clock size={14} /> À rembourser (en attente)
            </p>
            <p className="text-2xl font-bold text-white mt-1">
              {stats.pendingTotalChf.toFixed(2)} <span className="text-sm font-normal text-slate-400">CHF</span>
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {stats.pendingCount} demande{stats.pendingCount > 1 ? 's' : ''} à traiter
            </p>
          </div>
          <div className="w-11 h-11 rounded-full bg-amber-950/60 border border-amber-700/40 flex items-center justify-center text-amber-300">
            <Wallet size={22} />
          </div>
        </div>

        <div className="bg-slate-900 border border-emerald-800/50 rounded-xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={14} /> Remboursés (biffés)
            </p>
            <p className="text-2xl font-bold text-white mt-1">
              {stats.reimbursedTotalChf.toFixed(2)} <span className="text-sm font-normal text-slate-400">CHF</span>
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {stats.reimbursedCount} remboursement{stats.reimbursedCount > 1 ? 's' : ''} biffé{stats.reimbursedCount > 1 ? 's' : ''}
            </p>
          </div>
          <div className="w-11 h-11 rounded-full bg-emerald-950/60 border border-emerald-700/40 flex items-center justify-center text-emerald-300">
            <CheckSquare size={22} />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-center">
          <p className="text-xs font-semibold text-blue-400 mb-1">
            💡 Rapprochement bancaire intelligent
          </p>
          <p className="text-xs text-slate-400 leading-relaxed">
            La date du justificatif ne correspond pas à la date du virement de remboursement. Le rapprochement ignore l'écart de date et recherche le montant + le nom/prénom du membre.
          </p>
        </div>
      </div>

      {/* Filters & Search Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setStatusFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
              statusFilter === 'ALL'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            Tous ({stats.totalCount})
          </button>
          <button
            onClick={() => setStatusFilter('PENDING')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
              statusFilter === 'PENDING'
                ? 'bg-amber-600 text-white'
                : 'bg-slate-950 text-amber-300/80 hover:text-amber-200 border border-amber-800/40'
            }`}
          >
            ⏳ À rembourser ({stats.pendingCount})
          </button>
          <button
            onClick={() => setStatusFilter('REIMBURSED')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5 ${
              statusFilter === 'REIMBURSED'
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-950 text-emerald-300/80 hover:text-emerald-200 border border-emerald-800/40'
            }`}
          >
            ✅ Remboursés / Biffés ({stats.reimbursedCount})
          </button>
        </div>

        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 text-slate-500" size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher par nom, prénom, e-mail, IBAN, motif..."
            className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs sm:text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* Table / List of Reimbursements */}
      {filteredReimbursements.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center">
          <p className="text-base font-medium text-slate-300 mb-1">
            Aucune demande de remboursement à afficher
          </p>
          <p className="text-xs text-slate-500">
            Lorsqu'un membre envoie un justificatif avec l'option « 💶 À rembourser », il apparaît automatiquement ici avec ses coordonnées et son IBAN.
          </p>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[920px]">
              <thead className="bg-slate-950 border-b border-slate-800 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3.5 w-32">Statut / Biffer</th>
                  <th className="px-4 py-3.5">Personne à rembourser (Nom, Prénom, E-mail)</th>
                  <th className="px-4 py-3.5">IBAN</th>
                  <th className="px-4 py-3.5">Justificatif & Motif</th>
                  <th className="px-4 py-3.5 w-32">Montant</th>
                  <th className="px-4 py-3.5 w-64">Rapprochement Bancaire</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredReimbursements.map((receipt) => {
                  const isReimbursed = receipt.reimbursementStatus === 'REIMBURSED';
                  const identity = splitSubmitterIdentity(
                    receipt.submittedByName,
                    receipt.submittedByEmail
                  );
                  const linkedTxn = transactions.find(
                    (t) => t.id === receipt.linkedTransactionId
                  );
                  const potentialMatches = !linkedTxn
                    ? findPotentialMatchesForReceipt(receipt, transactions)
                    : [];

                  return (
                    <tr
                      key={receipt.id}
                      className={`transition-colors ${
                        isReimbursed
                          ? 'bg-emerald-950/10 hover:bg-emerald-950/20 opacity-75'
                          : 'hover:bg-slate-800/40'
                      }`}
                    >
                      {/* BIFFER / STATUT */}
                      <td className="px-4 py-4 align-top">
                        <button
                          onClick={() => handleToggleBiffer(receipt)}
                          disabled={isViewer}
                          title={
                            isReimbursed
                              ? 'Annuler le biffage (remettre en attente)'
                              : 'Biffer ce remboursement (marquer comme remboursé)'
                          }
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                            isReimbursed
                              ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/60 hover:bg-emerald-900/60'
                              : 'bg-amber-950/50 text-amber-300 border-amber-700/60 hover:bg-amber-900/50'
                          }`}
                        >
                          {isReimbursed ? (
                            <>
                              <CheckSquare size={15} className="text-emerald-400 shrink-0" />
                              <span>Remboursé</span>
                            </>
                          ) : (
                            <>
                              <Square size={15} className="text-amber-400 shrink-0" />
                              <span>À biffer</span>
                            </>
                          )}
                        </button>
                        {isReimbursed && receipt.reimbursedAt && (
                          <div className="mt-1.5 text-[10px] text-emerald-400/80 leading-tight">
                            Biffé le{' '}
                            {typeof receipt.reimbursedAt === 'number'
                              ? formatDate(new Date(receipt.reimbursedAt).toISOString().split('T')[0])
                              : String(receipt.reimbursedAt).split('T')[0]}
                            {receipt.reimbursedByName ? ` par ${receipt.reimbursedByName}` : ''}
                          </div>
                        )}
                      </td>

                      {/* PERSONNE À REMBOURSER : NOM, PRÉNOM, EMAIL */}
                      <td className="px-4 py-4 align-top">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span
                              className={`text-xs text-slate-400 ${
                                isReimbursed ? 'line-through decoration-emerald-500/70' : ''
                              }`}
                            >
                              Nom :{' '}
                              <strong className="text-slate-100 font-semibold">
                                {identity.lastName}
                              </strong>
                            </span>
                            <span
                              className={`text-xs text-slate-400 ${
                                isReimbursed ? 'line-through decoration-emerald-500/70' : ''
                              }`}
                            >
                              Prénom :{' '}
                              <strong className="text-slate-100 font-semibold">
                                {identity.firstName}
                              </strong>
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-slate-400">
                            <Mail size={12} className="text-blue-400 shrink-0" />
                            <span>E-mail :</span>
                            {identity.email !== '-' ? (
                              <a
                                href={`mailto:${identity.email}`}
                                className={`text-blue-400 hover:underline truncate max-w-[220px] ${
                                  isReimbursed ? 'line-through' : ''
                                }`}
                              >
                                {identity.email}
                              </a>
                            ) : (
                              <span className="text-slate-500 italic">Non renseigné</span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* IBAN */}
                      <td className="px-4 py-4 align-top">
                        {receipt.reimbursementIban ? (
                          <div className="flex flex-col items-start gap-1.5">
                            <span
                              className={`font-mono text-xs px-2 py-1 rounded bg-slate-950 border border-slate-800 text-amber-200 ${
                                isReimbursed ? 'line-through opacity-70' : ''
                              }`}
                            >
                              {receipt.reimbursementIban}
                            </span>
                            <button
                              onClick={() =>
                                handleCopyIban(receipt.id, receipt.reimbursementIban!)
                              }
                              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 px-2 py-0.5 rounded transition-colors cursor-pointer"
                            >
                              {copiedIbanId === receipt.id ? (
                                <>
                                  <Check size={11} className="text-emerald-400" />
                                  <span className="text-emerald-300">IBAN copié !</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={11} />
                                  <span>Copier l'IBAN</span>
                                </>
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500 italic">IBAN non fourni</span>
                        )}
                      </td>

                      {/* JUSTIFICATIF & MOTIF */}
                      <td className="px-4 py-4 align-top">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-semibold text-slate-200 text-xs sm:text-sm ${
                                isReimbursed ? 'line-through decoration-emerald-500/70' : ''
                              }`}
                            >
                              {receipt.merchantName || receipt.fileName}
                            </span>
                            <button
                              onClick={() => setSelectedReceipt(receipt)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-950/60 hover:bg-blue-900/60 text-blue-300 border border-blue-800/50 text-[11px] transition-colors cursor-pointer"
                              title="Voir le justificatif"
                            >
                              <Eye size={12} /> Voir
                            </button>
                          </div>
                          {(receipt.description || receipt.comment) && (
                            <p
                              className={`text-xs text-slate-300 italic ${
                                isReimbursed ? 'line-through opacity-70' : ''
                              }`}
                            >
                              « {receipt.description || receipt.comment} »
                            </p>
                          )}
                          <div className="flex items-center gap-1 text-[11px] text-slate-500">
                            <Calendar size={11} />
                            <span>
                              Date facture : {receipt.extractedDate || receipt.uploadDate}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* MONTANT */}
                      <td className="px-4 py-4 align-top">
                        <span
                          className={`text-base font-bold ${
                            isReimbursed
                              ? 'line-through text-emerald-400/80'
                              : 'text-amber-300'
                          }`}
                        >
                          {receipt.extractedAmount !== null &&
                          receipt.extractedAmount !== undefined
                            ? `${receipt.extractedAmount.toFixed(2)} CHF`
                            : '? CHF'}
                        </span>
                      </td>

                      {/* RAPPROCHEMENT BANCAIRE */}
                      <td className="px-4 py-4 align-top">
                        {linkedTxn ? (
                          <div className="bg-emerald-950/30 border border-emerald-800/50 rounded-lg p-2 text-xs">
                            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                              <LinkIcon size={12} />
                              <span>Lié au virement du {linkedTxn.date}</span>
                            </div>
                            <p className="text-[11px] text-slate-300 truncate mt-0.5" title={linkedTxn.description}>
                              {linkedTxn.simplifiedDescription || linkedTxn.description}
                            </p>
                          </div>
                        ) : potentialMatches.length > 0 ? (
                          <div className="bg-blue-950/30 border border-blue-800/50 rounded-lg p-2 text-xs space-y-1.5">
                            <div className="text-[11px] font-semibold text-blue-300">
                              écriture bancaire suggérée ({potentialMatches[0].date}) :
                            </div>
                            <p
                              className="text-[11px] text-slate-300 truncate"
                              title={potentialMatches[0].description}
                            >
                              {potentialMatches[0].simplifiedDescription ||
                                potentialMatches[0].description}{' '}
                              ({potentialMatches[0].amount.toFixed(2)} CHF)
                            </p>
                            {!isViewer && (
                              <button
                                onClick={() =>
                                  onLinkReceipt(receipt.id, potentialMatches[0].id)
                                }
                                className="w-full py-1 px-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors cursor-pointer"
                              >
                                <LinkIcon size={11} /> Lier ce virement
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500 italic">
                            Aucun virement correspondant trouvé pour l'instant
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Aperçu Justificatif */}
      {selectedReceipt && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedReceipt(null)}
        >
          <div
            className="bg-slate-900 rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col border border-slate-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-950">
              <div>
                <h3 className="font-bold text-slate-200 text-sm sm:text-base">
                  {selectedReceipt.merchantName || selectedReceipt.fileName}
                </h3>
                <p className="text-xs text-slate-400">
                  {selectedReceipt.submittedByName || selectedReceipt.submittedByEmail || ''}{' '}
                  {selectedReceipt.reimbursementIban
                    ? `• IBAN: ${selectedReceipt.reimbursementIban}`
                    : ''}
                </p>
              </div>
              <button
                onClick={() => setSelectedReceipt(null)}
                className="p-1.5 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white cursor-pointer"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-950 flex items-center justify-center">
              {isPdfReceipt(selectedReceipt) ? (
                <iframe
                  src={selectedReceipt.url}
                  title={selectedReceipt.fileName}
                  className="w-full h-[75vh] rounded border border-slate-800 bg-white"
                />
              ) : (
                <img
                  src={selectedReceipt.url}
                  alt="Justificatif de remboursement"
                  className="max-w-full max-h-[75vh] object-contain shadow-lg rounded"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
