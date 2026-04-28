
import React, { useState, useRef } from 'react';
import { Transaction, Account, TransactionStatus, AccountType } from '../../types';
import { generateAccountingReport } from '../services/excelService';
import { uploadReceipt } from '../services/storageService';
import { auditLedger } from '../services/geminiService';
import { AuditModal } from './AuditModal';
import { Check, X, AlertTriangle, Search, Filter, Calendar, Coins, XCircle, Eye, Edit2, Save, FileSpreadsheet, Paperclip, Loader2, Image as ImageIcon, Trash2, RefreshCw, RotateCcw, Archive, ShieldCheck } from 'lucide-react';
import { formatDate, dateToTimestamp } from '../services/formatUtils';

interface LedgerViewProps {
  transactions: Transaction[];
  accounts: Account[];
  receipts?: import('../../types').Receipt[];
  onUpdateTransaction: (transaction: Transaction) => void;
  onDeleteTransaction: (id: string) => void;
  onAutoMatch: () => void;
  onReanalyzeAll: () => void;
  onClearAll: (ids?: string[]) => void;
  onArchiveAll: () => void;
  autoMatchProgress: { current: number, total: number, message: string } | null;
  onGuessMember: (t: Transaction) => Promise<string | null>;
  onAddReceipt?: (receipt: import('../../types').Receipt) => void;
  onCloseFiscalYear: (finalAccounts: Account[], transactionsToArchive: Transaction[]) => Promise<void>;
}

export const LedgerView: React.FC<LedgerViewProps> = ({
  transactions,
  accounts,
  receipts,
  onUpdateTransaction,
  onDeleteTransaction,
  onAutoMatch,
  onReanalyzeAll,
  onClearAll,
  onArchiveAll,
  autoMatchProgress,
  onGuessMember,
  onAddReceipt,
  onCloseFiscalYear
}) => {
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [accountFilter, setAccountFilter] = useState('');

  // Editing State
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Transaction>>({});
  const [isGuessing, setIsGuessing] = useState<string | null>(null); // AI loading state

  // Audit State
  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [auditReport, setAuditReport] = useState("");
  const [isAuditing, setIsAuditing] = useState(false);

  const handleRunAudit = async () => {
    setIsAuditOpen(true);
    setIsAuditing(true);
    try {
      const report = await auditLedger(transactions, accounts);
      setAuditReport(report);
    } catch (e) {
      setAuditReport("Erreur critique lors de l'audit.");
    } finally {
      setIsAuditing(false);
    }
  };

  const allApproved = transactions.length > 0 && transactions.every(t => t.status === TransactionStatus.APPROVED);

  // Receipt Upload & Link State
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [linkingTxnId, setLinkingTxnId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedTxnRef = useRef<string | null>(null);

  // Filter available receipts for linking
  const availableReceipts = receipts?.filter(r => !r.linkedTransactionId) || [];

  const filteredTransactions = transactions.filter(t => {
    // Basic Status & Search
    const matchesFilter = filter === 'ALL'
      ? t.status !== TransactionStatus.ARCHIVED // Hide archives by default
      : (filter === 'UNCATEGORIZED' ? !t.accountId : t.status === filter);

    const matchesSearch = t.description.toLowerCase().includes(search.toLowerCase()) ||
      (t.simplifiedDescription && t.simplifiedDescription.toLowerCase().includes(search.toLowerCase())) ||
      t.amount.toString().includes(search) ||
      (t.detectedMemberName && t.detectedMemberName.toLowerCase().includes(search.toLowerCase()));

    // Date Range (convert to timestamps for proper comparison)
    let matchesDate = true;
    const txTimestamp = dateToTimestamp(t.date);
    if (startDate) {
      const startTimestamp = dateToTimestamp(startDate);
      if (txTimestamp < startTimestamp) matchesDate = false;
    }
    if (endDate) {
      const endTimestamp = dateToTimestamp(endDate) + 86400000; // Include the end date fully (add 24h)
      if (txTimestamp >= endTimestamp) matchesDate = false;
    }

    // Amount Range
    let matchesAmount = true;
    if (minAmount !== '' && t.amount < Number(minAmount)) matchesAmount = false;
    if (maxAmount !== '' && t.amount > Number(maxAmount)) matchesAmount = false;

    // Account filter
    let matchesAccount = true;
    if (accountFilter && t.accountId !== accountFilter) matchesAccount = false;

    return matchesFilter && matchesSearch && matchesDate && matchesAmount && matchesAccount;
  }).sort((a, b) => dateToTimestamp(b.date) - dateToTimestamp(a.date));

  const clearFilters = () => {
    setFilter('ALL');
    setSearch('');
    setStartDate('');
    setEndDate('');
    setMinAmount('');
    setMaxAmount('');
    setAccountFilter('');
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

  const getReceiptName = (t: Transaction) => {
    let rawName = "Justificatif";
    if (t.receiptFileName) {
        rawName = t.receiptFileName;
    } else if (t.receiptUrl) {
      if (t.receiptUrl.startsWith('data:')) return "Nouveau justificatif";
      try {
        const decoded = decodeURIComponent(t.receiptUrl);
        const pathParts = decoded.split('?')[0].split('/');
        rawName = pathParts[pathParts.length - 1] || "Justificatif";
      } catch (e) {
        rawName = "Justificatif";
      }
    }
    
    if (rawName !== "Justificatif" && rawName !== "Joindre") {
        let cleanName = rawName;
        
        // 1. Remove Firebase timestamp prefix (e.g. "1710453234_MyReceipt.pdf")
        const parts = rawName.split('_');
        if (parts.length > 1 && !isNaN(Number(parts[0])) && parts[0].length >= 10) {
            cleanName = parts.slice(1).join('_');
        }
        
        // 2. Remove date patterns: YYYY-MM-DD, DD-MM-YYYY, etc.
        // Also captures trailing dashes/underscores/spaces after the date.
        cleanName = cleanName.replace(/\d{2,4}[-.\/]\d{2}[-.\/]\d{2,4}[-_ ]?/g, '');
        
        // 3. Remove UUID-like strings or long random strings if they are at the beginning
        cleanName = cleanName.replace(/^[a-f0-9-]{20,}[-_ ]?/, '');

        // 4. Final trim and cleanup
        cleanName = cleanName.trim();
        
        // If we stripped too MUCH (e.g. the file was ONLY a date), fallback to raw
        const nameWithoutExt = cleanName.replace(/\.[^/.]+$/, "");
        if (!nameWithoutExt.trim() || cleanName.length < 3) return rawName;
        
        return cleanName;
    }
    
    return rawName === "Justificatif" && !t.receiptUrl ? "Joindre" : rawName;
  };

  // --- RECEIPT LOGIC ---

  const openReceipt = (url: string) => {
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
        onUpdateTransaction({ ...txn, receiptUrl: url, receiptFileName: file.name });
        
        // Ensure the receipt is added to the global `receipts` state!
        if (onAddReceipt) {
           onAddReceipt({
               id: `rcpt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
               url: url,
               fileName: file.name,
               uploadDate: new Date().toISOString().split('T')[0],
               extractedDate: null, 
               extractedAmount: null, 
               isAnalyzed: true,
               linkedTransactionId: txn.id
           });
        }
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

  // Helper to display account name with hierarchy (supports 3 levels)
  const renderAccountOption = (acc: Account) => {
    if (acc.parentId) {
      const parent = accounts.find(p => p.id === acc.parentId);
      if (parent && parent.parentId) {
        const grandParent = accounts.find(gp => gp.id === parent.parentId);
        return `${grandParent ? grandParent.label + ' > ' : ''}${parent.label} > ${acc.label}`;
      }
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
            onClick={() => onClearAll(filteredTransactions.map(t => t.id))}
            disabled={!!autoMatchProgress}
            title={transactions.length === filteredTransactions.length ? "Supprimer TOUTES les transactions" : "Supprimer uniquement les transactions FILTRÉES"}
          >
            <Trash2 size={16} />
            Tout Effacer
          </button>

          <div className="w-px h-8 bg-slate-700 mx-2"></div>

          <button
            className={`px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white rounded-lg hover:from-amber-600 hover:to-orange-700 text-sm font-bold flex items-center gap-2 shadow-lg shadow-orange-900/20 transition-all ${!allApproved ? 'opacity-50 cursor-not-allowed grayscale' : ''}`}
            onClick={allApproved ? handleRunAudit : undefined}
            title={allApproved ? "Générer le rapport de clôture" : "Validez toutes les transactions pour auditer"}
          >
            <ShieldCheck size={18} />
            Clôture & Audit
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

          {/* Account Filter */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-slate-500 min-w-fit">
              <Filter size={16} />
              <span className="text-sm font-medium">Compte:</span>
            </div>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 outline-none text-slate-200 w-48"
            >
              <option value="">Tous les comptes</option>
              {accounts
                .filter(a => a.type !== AccountType.MIXED)
                .sort((a, b) => a.code.localeCompare(b.code))
                .map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.code} - {acc.label}
                  </option>
                ))
              }
            </select>
          </div>

          <div className="hidden md:block w-px h-6 bg-slate-800"></div>

          {/* Amount Range */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-slate-500 min-w-fit">
              <Coins size={16} />
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
            (startDate || endDate || minAmount || maxAmount || search || filter !== 'ALL' || accountFilter) && (
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
              <th className="px-6 py-3 font-semibold text-slate-400">Libellé & Notes</th>
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
                    ) : formatDate(t.date)}
                  </td>

                  {/* DESCRIPTION & NOTES */}
                  <td className="px-6 py-4 font-medium text-slate-200">
                    {isEditing ? (
                      <div className="flex flex-col gap-2">
                        <input
                          type="text"
                          value={editForm.description || ''}
                          onChange={e => setEditForm({ ...editForm, description: e.target.value })}
                          className="bg-slate-950 border border-blue-500 rounded px-2 py-1 w-full focus:outline-none text-white text-sm"
                          placeholder="Libellé"
                        />
                        <textarea
                          value={editForm.notes || ''}
                          onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
                          className="bg-slate-950 border border-slate-600 rounded px-2 py-1 w-full focus:outline-none focus:border-blue-500 text-slate-300 text-xs resize-none"
                          placeholder="Ajouter une note (visible uniquement ici)..."
                          rows={2}
                        />
                      </div>
                    ) : (
                      <div 
                        className="flex flex-col cursor-help group" 
                        title={`VERSION COMPLÈTE :\n${t.description}${t.fullRawText && t.fullRawText !== t.description ? '\n\nTEXTE BRUT :\n' + t.fullRawText : ''}`}
                      >
                        <span className="group-hover:text-blue-400 transition-colors">
                          {t.simplifiedDescription || t.description}
                        </span>
                        {t.notes && (
                          <span className="text-xs text-blue-300/80 mt-1 italic border-l-2 border-blue-500/30 pl-2 whitespace-pre-wrap">
                            {t.notes}
                          </span>
                        )}
                        {!t.simplifiedDescription && t.fullRawText && t.fullRawText !== t.description && (
                          <span className="text-[10px] text-slate-500 font-normal italic line-clamp-1 opacity-70 mt-1">
                            {t.fullRawText}
                          </span>
                        )}
                        {t.simplifiedDescription && (
                           <span className="text-[9px] text-slate-600 font-bold uppercase tracking-tighter mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                             Survoler pour l'original
                           </span>
                        )}
                      </div>
                    )}
                  </td>

                  {/* RECEIPT / JUSTIFICATIF */}
                  <td className="px-6 py-4">
                    {isUploading ? (
                      <Loader2 className="animate-spin text-blue-500" size={16} />
                    ) : t.receiptUrl ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openReceipt(t.receiptUrl!)}
                          className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 bg-blue-900/20 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
                          title="Voir le justificatif"
                        >
                          <ImageIcon size={14} />
                          <span className="truncate max-w-[120px]">{getReceiptName(t)}</span>
                        </button>
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
                        onClick={() => setLinkingTxnId(t.id)}
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
                                // VALIDATION LOGIC
                                if (!t.accountId) {
                                  alert("Impossible de valider : Aucun compte sélectionné.");
                                  return;
                                }
                                const currentAccount = accounts.find(a => a.id === t.accountId);
                                if (!currentAccount) {
                                  alert("Impossible de valider : Compte introuvable.");
                                  return;
                                }
                                // Check Charge (Negative) vs Product (Positive)
                                if (t.amount < 0 && currentAccount.type !== AccountType.EXPENSE) {
                                  alert(`Erreur de validation : Une dépense (montant négatif) doit être associée à un compte de CHARGE (Type 6).\nCompte actuel : ${currentAccount.type}`);
                                  return;
                                }
                                if (t.amount > 0 && currentAccount.type !== AccountType.INCOME) {
                                  alert(`Erreur de validation : Une recette (montant positif) doit être associée à un compte de PRODUIT (Type 7).\nCompte actuel : ${currentAccount.type}`);
                                  return;
                                }

                                // On Approve, if Membership Account + No Member Name, try extraction
                                let finalMemberName = t.detectedMemberName;


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

      {/* Receipt Linking Modal */}
      {linkingTxnId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-lg w-full max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-slate-800/50">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Paperclip size={20} className="text-blue-400" />
                Lier un justificatif existant
              </h2>
              <button 
                onClick={() => setLinkingTxnId(null)} 
                className="text-slate-400 hover:text-white transition-colors p-1"
                title="Fermer"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-4 overflow-y-auto flex-1 h-[400px]">
              {availableReceipts.length === 0 ? (
                <div className="text-center py-12 text-slate-500 flex flex-col items-center gap-3">
                  <Archive size={42} className="opacity-20" />
                  <p className="text-lg font-medium">Aucun justificatif disponible</p>
                  <p className="text-sm max-w-xs">Tous vos justificatifs importés ont déjà été liés à une transaction.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-slate-400 font-semibold tracking-wider uppercase mb-1">
                    Justificatifs en attente ({availableReceipts.length})
                  </p>
                  {availableReceipts.map(receipt => (
                    <div 
                      key={receipt.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-slate-700 bg-slate-800/30 hover:bg-slate-700/50 hover:border-slate-600 transition-all cursor-pointer group"
                      onClick={() => {
                        const txn = transactions.find(t => t.id === linkingTxnId);
                        if (txn) {
                          onUpdateTransaction({ ...txn, receiptUrl: receipt.url, receiptFileName: receipt.fileName });
                           if (onAddReceipt) {
                               onAddReceipt({
                                   ...receipt,
                                   linkedTransactionId: txn.id
                               });
                           }
                          setLinkingTxnId(null);
                        }
                      }}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2 bg-slate-900/80 rounded border border-slate-700 text-blue-400 shrink-0">
                          <FileSpreadsheet size={18} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-200 truncate pr-2">
                            {receipt.fileName}
                          </p>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-slate-500">
                             <span className="flex items-center gap-1" title="Date d'importation">
                              <Calendar size={12} />
                              {receipt.uploadDate}
                            </span>
                            {receipt.extractedAmount !== null && (
                              <span className="flex items-center gap-1 font-medium text-slate-400">
                                <coins size={12} />
                                {receipt.extractedAmount}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 pl-2">
                         <div className="text-xs font-medium px-3 py-1.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 group-hover:bg-blue-500 group-hover:text-white transition-colors flex items-center gap-1.5">
                            Lier <Check size={14} className="opacity-0 group-hover:opacity-100 transition-opacity -ml-1" />
                         </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className="p-4 border-t border-slate-700 bg-slate-800 text-sm text-slate-400 flex flex-col gap-3">
               <p>Vous souhaitez ajouter un nouveau fichier ?</p>
               <button 
                  onClick={() => {
                     setLinkingTxnId(null);
                     handleAttachClick(linkingTxnId!);
                  }}
                  className="w-full py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2 font-medium"
               >
                  <Paperclip size={16} /> Parcourir mon PC...
               </button>
            </div>
          </div>
        </div>
      )}

      <AuditModal
        isOpen={isAuditOpen}
        onClose={() => setIsAuditOpen(false)}
        report={auditReport}
        loading={isAuditing}
        transactions={transactions}
        accounts={accounts}
        onCloseFiscalYear={onCloseFiscalYear}
      />
    </div >
  );
};
