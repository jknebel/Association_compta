
import React, { useState, useRef } from 'react';
import { Transaction, Account, TransactionStatus, AccountType } from '../../types';
import { generateAccountingReport } from '../services/excelService';
import { uploadReceipt } from '../services/storageService';
import { Check, X, AlertTriangle, Search, Filter, Calendar, DollarSign, XCircle, Eye, Edit2, Save, FileSpreadsheet, Paperclip, Loader2, Image as ImageIcon, Trash2, RefreshCw, RotateCcw, Archive } from 'lucide-react';

interface LedgerViewProps {
  transactions: Transaction[];
  accounts: Account[];
  onUpdateTransaction: (transaction: Transaction) => void;
  onDeleteTransaction: (id: string) => void;
  onAutoMatch: () => void;
  onReanalyzeAll: () => void;
  onClearAll: () => void;
  onArchiveAll: () => void;
  autoMatchProgress: { current: number, total: number, message: string } | null;
  onGuessMember?: (t: Transaction) => Promise<string | null>;
}

export const LedgerView: React.FC<LedgerViewProps> = ({
  transactions,
  accounts,
  onUpdateTransaction,
  onDeleteTransaction,
  onAutoMatch,
  onReanalyzeAll,
  onClearAll,
  onArchiveAll,
  autoMatchProgress,
  onGuessMember
}) => {
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');

  // Editing State
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Transaction>>({});
  const [isGuessing, setIsGuessing] = useState<string | null>(null); // AI loading state

  // Receipt Upload State
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedTxnRef = useRef<string | null>(null);

  const filteredTransactions = transactions.filter(t => {
    // Basic Status & Search
    const matchesFilter = filter === 'ALL'
      ? t.status !== TransactionStatus.ARCHIVED // Hide archives by default
      : (filter === 'UNCATEGORIZED' ? !t.accountId : t.status === filter);

    const matchesSearch = t.description.toLowerCase().includes(search.toLowerCase()) ||
      t.amount.toString().includes(search) ||
      (t.detectedMemberName && t.detectedMemberName.toLowerCase().includes(search.toLowerCase()));

    // Date Range
    let matchesDate = true;
    if (startDate && t.date < startDate) matchesDate = false;
    if (endDate && t.date > endDate) matchesDate = false;

    // Amount Range
    let matchesAmount = true;
    if (minAmount !== '' && t.amount < Number(minAmount)) matchesAmount = false;
    if (maxAmount !== '' && t.amount > Number(maxAmount)) matchesAmount = false;

    return matchesFilter && matchesSearch && matchesDate && matchesAmount;
  });

  const clearFilters = () => {
    setFilter('ALL');
    setSearch('');
    setStartDate('');
    setEndDate('');
    setMinAmount('');
    setMaxAmount('');
  };

  const startEditing = (t: Transaction) => {
    setEditingId(t.id);
    setEditForm({ ...t });
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditForm({});
  };

  const saveEditing = () => {
    if (editingId && editForm) {
      // Find original to merge properly
      const original = transactions.find(t => t.id === editingId);
      if (original) {
        onUpdateTransaction({
          ...original,
          ...editForm,
          amount: Number(editForm.amount), // Ensure number
          status: TransactionStatus.REVIEW_NEEDED // Reset status to review on manual change
        } as Transaction);
      }
      setEditingId(null);
      setEditForm({});
    }
  };

  // --- RECEIPT LOGIC ---

  const handleAttachClick = (txnId: string) => {
    selectedTxnRef.current = txnId;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const txnId = selectedTxnRef.current;

    if (!file || !txnId) return;

    // For demo purposes, we limit size because LocalStorage is small
    if (file.size > 1024 * 1024) {
      alert("Pour cette démo sans Firebase, l'image doit faire moins de 1 Mo.");
      return;
    }

    setUploadingId(txnId);
    try {
      const url = await uploadReceipt(file);
      const txn = transactions.find(t => t.id === txnId);
      if (txn) {
        onUpdateTransaction({ ...txn, receiptUrl: url });
      }
    } catch (err) {
      alert("Erreur lors de l'upload du justificatif.");
      console.error(err);
    } finally {
      setUploadingId(null);
      selectedTxnRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveReceipt = (txn: Transaction) => {
    if (window.confirm("Supprimer ce justificatif ?")) {
      onUpdateTransaction({ ...txn, receiptUrl: undefined });
    }
  };

  const handleDeleteClick = (id: string) => {
    if (window.confirm("Voulez-vous vraiment supprimer cette transaction ? Cette action est irréversible.")) {
      onDeleteTransaction(id);
    }
  };


  const getStatusBadge = (status: TransactionStatus) => {
    switch (status) {
      case TransactionStatus.APPROVED:
        return {
          className: 'bg-green-900/30 text-green-400 border-green-800',
          icon: <Check size={12} />,
          label: 'Approuvé'
        };
      case TransactionStatus.PENDING_REVIEW:
        return {
          className: 'bg-indigo-900/30 text-indigo-400 border-indigo-800',
          icon: <Eye size={12} />,
          label: 'En Attente de Revue'
        };
      case TransactionStatus.REVIEW_NEEDED:
        return {
          className: 'bg-amber-900/30 text-amber-400 border-amber-800',
          icon: <AlertTriangle size={12} />,
          label: 'À Vérifier'
        };
      case TransactionStatus.ARCHIVED:
        return {
          className: 'bg-slate-700/30 text-slate-400 border-slate-600',
          icon: <Check size={12} />, // Or another icon
          label: 'Archivé'
        };
      default:
        return {
          className: 'bg-slate-800 text-slate-400 border-slate-700',
          icon: null,
          label: 'En Attente'
        };
    }
  };

  // Helper to display account name with hierarchy
  const renderAccountOption = (acc: Account) => {
    if (acc.parentId) {
      const parent = accounts.find(p => p.id === acc.parentId);
      // Changed separator to ' > ' as requested
      return `${parent ? parent.label + ' > ' : ''}${acc.label}`;
    }
    return acc.label;
  };

  return (
    <div className="p-6 h-full flex flex-col">
      <header className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-100">Journal des Transactions</h2>
          <p className="text-slate-400">Vérifiez, modifiez et classez vos transactions importées.</p>
        </div>
        <div className="flex gap-2">
          <button
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium flex items-center gap-2 shadow-sm transition-colors"
            onClick={() => generateAccountingReport(filteredTransactions, accounts)}
          >
            <FileSpreadsheet size={16} />
            Exporter Bilan & Journal (.xlsx)
          </button>
          <button
            className={`px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium flex items-center gap-2 shadow-sm transition-colors ${autoMatchProgress ? 'opacity-80 cursor-wait' : ''}`}
            onClick={onAutoMatch}
            disabled={!!autoMatchProgress}
          >
            {autoMatchProgress ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {autoMatchProgress.message}
              </>
            ) : (
              <>
                <RefreshCw size={16} />
                Auto-Match
              </>
            )}
          </button>
          <button
            className={`px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium flex items-center gap-2 shadow-sm transition-colors ${autoMatchProgress ? 'opacity-80 cursor-wait' : ''}`}
            onClick={onReanalyzeAll}
            disabled={!!autoMatchProgress}
            title="Relancer l'analyse IA sur toutes les transactions (écrase les catégories existantes)"
          >
            <RotateCcw size={16} />
            Re-Scan Complet
          </button>

          <button
            className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600 text-sm font-medium flex items-center gap-2 shadow-sm transition-colors ml-2"
            onClick={onArchiveAll}
            disabled={!!autoMatchProgress}
            title="Archiver toutes les transactions visibles"
          >
            <Archive size={16} />
            Archiver Tout
          </button>

          <button
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium flex items-center gap-2 shadow-sm transition-colors"
            onClick={onClearAll}
            disabled={!!autoMatchProgress}
            title="Supprimer TOUTES les transactions pour recommencer"
          >
            <Trash2 size={16} />
            Tout Effacer
          </button>
        </div>
      </header>

      {/* Filters Container */}
      <div className="mb-6 bg-slate-900 p-5 rounded-xl shadow-sm border border-slate-800 space-y-4">
        {/* Top Row: Search & Status */}
        <div className="flex flex-col md:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 text-slate-500" size={18} />
            <input
              type="text"
              placeholder="Rechercher libellé, montant ou membre..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-950 border border-slate-700 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-slate-200 placeholder-slate-600"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter size={18} className="text-slate-500" />
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="border border-slate-700 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none bg-slate-950 text-slate-200 min-w-[150px]"
            >
              <option value="ALL">Tous les statuts</option>
              <option value="UNCATEGORIZED">⚠️ Non Catégorisé</option>
              <option value={TransactionStatus.PENDING}>En Attente</option>
              <option value={TransactionStatus.REVIEW_NEEDED}>À Vérifier</option>
              <option value={TransactionStatus.PENDING_REVIEW}>En Attente de Revue</option>
              <option value={TransactionStatus.APPROVED}>Approuvé</option>
              <option value={TransactionStatus.ARCHIVED}>📦 Archives</option>
            </select>
          </div>
        </div >

        {/* Bottom Row: Date & Amount Range */}
        < div className="flex flex-wrap items-center gap-6 pt-4 border-t border-slate-800" >
          {/* Date Range */}
          < div className="flex items-center gap-2" >
            <div className="flex items-center gap-2 text-slate-500 min-w-fit">
              <Calendar size={16} />
              <span className="text-sm font-medium">Date:</span>
            </div>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 outline-none text-slate-200"
            />
            <span className="text-slate-600">-</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 outline-none text-slate-200"
            />
          </div >

          <div className="hidden md:block w-px h-6 bg-slate-800"></div>

          {/* Amount Range */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-slate-500 min-w-fit">
              <DollarSign size={16} />
              <span className="text-sm font-medium">Montant:</span>
            </div>
            <input
              type="number"
              placeholder="Min"
              value={minAmount}
              onChange={(e) => setMinAmount(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm w-24 focus:ring-1 focus:ring-blue-500 outline-none text-slate-200"
            />
            <span className="text-slate-600">-</span>
            <input
              type="number"
              placeholder="Max"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm w-24 focus:ring-1 focus:ring-blue-500 outline-none text-slate-200"
            />
          </div>

          {/* Active Filters Clear Button */}
          {
            (startDate || endDate || minAmount || maxAmount || search || filter !== 'ALL') && (
              <button
                onClick={clearFilters}
                className="ml-auto flex items-center gap-1.5 text-xs text-rose-400 hover:text-rose-300 font-medium px-3 py-1.5 bg-rose-900/20 hover:bg-rose-900/40 rounded-lg transition-colors"
              >
                <XCircle size={14} />
                Tout Effacer
              </button>
            )
          }
        </div >
      </div >

      {/* Hidden File Input for Receipt Upload */}
      < input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*,application/pdf"
        onChange={handleFileChange}
      />

      {/* Table Section */}
      < div className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 overflow-hidden flex-1 overflow-y-auto" >
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-950 border-b border-slate-800 sticky top-0 z-10">
            <tr>
              <th className="px-6 py-3 font-semibold text-slate-400 w-32">Date</th>
              <th className="px-6 py-3 font-semibold text-slate-400">Libellé</th>
              <th className="px-6 py-3 font-semibold text-slate-400 w-32">Justificatif</th>
              <th className="px-6 py-3 font-semibold text-slate-400 w-32">Montant</th>
              <th className="px-6 py-3 font-semibold text-slate-400 w-48">Compte</th>
              <th className="px-6 py-3 font-semibold text-slate-400 w-32">Membre</th>
              <th className="px-6 py-3 font-semibold text-slate-400 w-32">Statut</th>
              <th className="px-6 py-3 font-semibold text-slate-400 text-right w-40">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {filteredTransactions.map((t) => {
              const badge = getStatusBadge(t.status);
              const isEditing = editingId === t.id;
              const isUploading = uploadingId === t.id;

              // Filter valid accounts
              const validAccounts = accounts.filter(a => {
                if (a.type === AccountType.MIXED) return false;
                if (t.amount > 0) return a.type === AccountType.INCOME;
                if (t.amount < 0) return a.type === AccountType.EXPENSE;
                return true;
              });
              validAccounts.sort((a, b) => a.code.localeCompare(b.code));

              return (
                <tr key={t.id} className={`transition-colors ${isEditing ? 'bg-blue-900/20' : 'hover:bg-slate-800/50'}`}>

                  {/* DATE */}
                  <td className="px-6 py-4 text-slate-300 whitespace-nowrap">
                    {isEditing ? (
                      <input
                        type="date"
                        value={editForm.date || ''}
                        onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                        className="bg-slate-950 border border-blue-500 rounded px-2 py-1 w-full focus:outline-none text-white"
                      />
                    ) : t.date}
                  </td>

                  {/* DESCRIPTION */}
                  <td className="px-6 py-4 font-medium text-slate-200">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editForm.description || ''}
                        onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                        className="bg-slate-950 border border-blue-500 rounded px-2 py-1 w-full focus:outline-none text-white"
                      />
                    ) : t.description}
                  </td>

                  {/* RECEIPT / JUSTIFICATIF */}
                  <td className="px-6 py-4">
                    {isUploading ? (
                      <Loader2 className="animate-spin text-blue-500" size={16} />
                    ) : t.receiptUrl ? (
                      <div className="flex items-center gap-2">
                        <a
                          href={t.receiptUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 bg-blue-900/20 px-2 py-1 rounded text-xs transition-colors"
                          title="Voir le justificatif"
                        >
                          <ImageIcon size={14} />
                          Voir
                        </a>
                        {isEditing && (
                          <button
                            onClick={() => handleRemoveReceipt(t)}
                            className="text-rose-400 hover:text-rose-300 p-1"
                            title="Supprimer le justificatif"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => handleAttachClick(t.id)}
                        className="text-slate-500 hover:text-blue-400 transition-colors flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-800 text-xs"
                      >
                        <Paperclip size={14} />
                        Joindre
                      </button>
                    )}
                  </td>

                  {/* AMOUNT */}
                  <td className={`px-6 py-4 font-bold ${t.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isEditing ? (
                      <input
                        type="number"
                        value={editForm.amount}
                        onChange={e => setEditForm({ ...editForm, amount: parseFloat(e.target.value) })}
                        className="bg-slate-950 border border-blue-500 rounded px-2 py-1 w-24 focus:outline-none text-white"
                        step="0.01"
                      />
                    ) : `CHF ${t.amount.toFixed(2)}`}
                  </td>

                  {/* ACCOUNT */}
                  <td className="px-6 py-4">
                    <select
                      value={isEditing ? (editForm.accountId || '') : (t.accountId || '')}
                      onChange={(e) => {
                        const newAccountId = e.target.value;
                        const selectedAccount = accounts.find(a => a.id === newAccountId);
                        let detectedMemberName = isEditing ? editForm.detectedMemberName : t.detectedMemberName;

                        // Auto-extract member name if account is a Membership account (Class 7 + isMembership)
                        if (selectedAccount?.isMembership) {
                          // REFINED LOGIC: VIRT CPTE as "Last Resort".
                          // If we already have a name (from AI or previous edit), we KEEP it (Strategy 1).
                          // We only search if detectedMemberName is empty.
                          if (!detectedMemberName) {
                            const desc = isEditing ? (editForm.description || t.description) : t.description;
                            // Last Resort: VIRT CPTE
                            const virtMatch = desc.match(/(?:VIRT\s+CPTE|VIREMENT\s+DE|VIREMENT)\s+(?:DE\s+)?([A-Z\s\.]+)/i);
                            if (virtMatch && virtMatch[1]) {
                              detectedMemberName = virtMatch[1].trim();
                            }
                          }
                        }

                        if (isEditing) {
                          setEditForm({ ...editForm, accountId: newAccountId, detectedMemberName })
                        } else {
                          onUpdateTransaction({ ...t, accountId: newAccountId, detectedMemberName, status: TransactionStatus.REVIEW_NEEDED })
                        }
                      }}
                      className={`bg-transparent border-b border-dashed border-slate-600 focus:border-blue-500 focus:outline-none py-1 max-w-[200px] truncate ${!(isEditing ? editForm.accountId : t.accountId) ? 'text-rose-400 font-semibold' : 'text-slate-300'} [&>option]:bg-slate-900 [&>option]:text-white`}
                    >
                      <option value="">
                        {validAccounts.length === 0 ? "Aucun compte correspondant" : "Sélectionner Compte..."}
                      </option>
                      {validAccounts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} - {renderAccountOption(a)}</option>
                      ))}
                      {t.accountId && !validAccounts.find(a => a.id === t.accountId) && accounts.find(a => a.id === t.accountId) && (
                        <option value={t.accountId} disabled>
                          ⚠️ {accounts.find(a => a.id === t.accountId)?.code} - {renderAccountOption(accounts.find(a => a.id === t.accountId)!)} (Invalide)
                        </option>
                      )}
                    </select>
                  </td>

                  {/* MEMBER */}
                  <td className="px-6 py-4">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editForm.detectedMemberName || ''}
                        placeholder="Nom du membre"
                        onChange={e => setEditForm({ ...editForm, detectedMemberName: e.target.value })}
                        className="bg-slate-950 border border-blue-500 rounded px-2 py-1 w-full focus:outline-none text-sm text-white"
                      />
                    ) : (
                      t.detectedMemberName ? (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-purple-900/30 text-purple-300 border border-purple-800">
                          {t.detectedMemberName}
                        </span>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )
                    )}
                  </td>

                  {/* STATUS */}
                  <td className="px-6 py-4">
                    {!isEditing && (
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${badge.className}`}>
                        {badge.icon}
                        {badge.label}
                      </span>
                    )}
                  </td>

                  {/* ACTIONS */}
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isEditing ? (
                        <>
                          <button onClick={saveEditing} className="p-1.5 bg-blue-900/30 text-blue-400 rounded-md hover:bg-blue-900/50 transition-colors" title="Enregistrer">
                            <Save size={16} />
                          </button>
                          <button onClick={cancelEditing} className="p-1.5 bg-slate-800 text-slate-400 rounded-md hover:bg-slate-700 transition-colors" title="Annuler">
                            <X size={16} />
                          </button>
                        </>
                      ) : (
                        <>
                          {/* Edit Button */}
                          <button
                            onClick={() => startEditing(t)}
                            className="p-1.5 hover:bg-blue-900/30 text-blue-400 rounded-md transition-colors"
                            title="Modifier"
                          >
                            <Edit2 size={16} />
                          </button>

                          {/* Move to Pending Review Button */}
                          {t.status !== TransactionStatus.APPROVED && t.status !== TransactionStatus.PENDING_REVIEW && (
                            <button
                              onClick={() => onUpdateTransaction({ ...t, status: TransactionStatus.PENDING_REVIEW })}
                              className="p-1.5 hover:bg-indigo-900/30 text-indigo-400 rounded-md transition-colors"
                              title="Marquer pour Revue"
                            >
                              <Eye size={16} />
                            </button>
                          )}

                          {/* Approve Button */}
                          {t.status !== TransactionStatus.APPROVED && (
                            <button
                              onClick={async () => {
                                // On Approve, if Membership Account + No Member Name, try extraction
                                let finalMemberName = t.detectedMemberName;
                                const currentAccount = accounts.find(a => a.id === t.accountId);

                                if (currentAccount?.isMembership && !finalMemberName) {
                                  // 1. Try AI (Server-Side, Slow but Smart)
                                  if (onGuessMember) {
                                    setIsGuessing(t.id);
                                    try {
                                      const aiName = await onGuessMember(t);
                                      if (aiName) {
                                        finalMemberName = aiName;
                                      } else {
                                        // 2. Fallback to Regex if AI found nothing
                                        throw new Error("AI returned null");
                                      }
                                    } catch (e) {
                                      // 3. Fallback to Regex (Client-Side, Fast) on error or empty AI
                                      const virtMatch = t.description.match(/(?:VIRT\s+CPTE|VIREMENT\s+DE|VIREMENT)\s+(?:DE\s+)?([A-Z\s\.]+)/i);
                                      if (virtMatch && virtMatch[1]) {
                                        finalMemberName = virtMatch[1].trim();
                                      }
                                    } finally {
                                      setIsGuessing(null);
                                    }
                                  } else {
                                    // No AI available, just Regex
                                    const virtMatch = t.description.match(/(?:VIRT\s+CPTE|VIREMENT\s+DE|VIREMENT)\s+(?:DE\s+)?([A-Z\s\.]+)/i);
                                    if (virtMatch && virtMatch[1]) {
                                      finalMemberName = virtMatch[1].trim();
                                    }
                                  }
                                }

                                onUpdateTransaction({ ...t, detectedMemberName: finalMemberName, status: TransactionStatus.APPROVED });
                              }}
                              disabled={isGuessing === t.id}
                              className={`p-1.5 rounded-md transition-colors ${isGuessing === t.id ? 'bg-slate-800 text-slate-500 cursor-wait' : 'hover:bg-green-900/30 text-green-400'}`}
                              title={isGuessing === t.id ? "Recherche IA en cours..." : "Approuver (avec recherche membre)"}
                            >
                              {isGuessing === t.id ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                            </button>
                          )}

                          {/* Delete Button */}
                          <button
                            onClick={() => handleDeleteClick(t.id)}
                            className="p-1.5 hover:bg-rose-900/30 text-rose-400 rounded-md transition-colors"
                            title="Supprimer"
                          >
                            <X size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {
          filteredTransactions.length === 0 && (
            <div className="p-12 text-center text-slate-500">
              Aucune transaction trouvée correspondant à vos critères.
            </div>
          )
        }
      </div >
    </div >
  );
};
