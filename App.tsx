
import React, { useState, useRef } from 'react';
import { Layout } from './frontend/components/Layout';
import { Dashboard } from './frontend/components/Dashboard';
import { UploadView } from './frontend/components/UploadView';
import { LedgerView } from './frontend/components/LedgerView';
import { ExpertChat } from './frontend/components/ExpertChat';
import { SettingsView } from './frontend/components/SettingsView';
import { LoginView } from './frontend/components/LoginView';
import { ReceiptsView } from './frontend/components/ReceiptsView';

import { Account, Transaction, AccountType, Receipt, TransactionStatus } from './types';
import { Edit2, Save, X, AlertTriangle, CloudOff, Loader2, Download, Upload, CheckCircle, XCircle, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { useDataService } from './frontend/services/dataService';
import { useAuth } from './frontend/services/authService';
import * as XLSX from 'xlsx';
import { matchTransactionsWithReceipts } from './frontend/services/matchingService';
import { suggestCategory } from './frontend/services/geminiService';

function App() {
    const [activeTab, setActiveTab] = useState('dashboard');
    const [guestMode, setGuestMode] = useState(false);

    // 1. Check Authentication Status
    const { user, loading: authLoading } = useAuth();

    // 2. Load Data for the specific User OR Guest
    const {
        accounts,
        transactions,
        receipts,
        loading: dataLoading,
        isConfigured,
        saveAccount,
        replaceAllAccounts,
        deleteAccount,
        saveTransaction,
        saveTransactions,
        deleteTransaction,
        saveReceipt,
        deleteReceipt,
        deleteAllTransactions
    } = useDataService(user, guestMode);

    // Handle new transactions from Upload Agent
    const handleProcessComplete = async (newTxns: Transaction[], newAccounts: Account[], matchedReceiptIds: string[] = []) => {

        let txnsToSave = [...newTxns];
        let receiptIdsToUpdate = [...matchedReceiptIds];

        // 1. Auto-Match with Receipts (if not already done by backend, usually backend doesn't do receipt matching)
        // We match against existing receipts that are not linked
        const { processedTxns, matchedReceiptIds: newMatchedIds } = matchTransactionsWithReceipts(txnsToSave, receipts);
        txnsToSave = processedTxns;
        receiptIdsToUpdate = [...receiptIdsToUpdate, ...newMatchedIds]; // Merge potential Backend matches (if any) with Client matches

        // 2. Auto-Suggest Categories for those missing accountId
        const uncategorized = txnsToSave.filter(t => !t.accountId);
        if (uncategorized.length > 0) {
            console.log("Auto-categorizing", uncategorized.length, "transactions...");
            const categorized = await Promise.all(uncategorized.map(async (t) => {
                try {
                    const result = await suggestCategory(t.description, accounts);
                    if (result.accountId) {
                        return {
                            ...t,
                            accountId: result.accountId || undefined,
                            detectedMemberName: result.memberName || undefined,
                            status: TransactionStatus.REVIEW_NEEDED
                        };
                    }
                } catch (err) {
                    console.warn("Auto-cat failed for", t.description, err);
                }
                return t;
            }));

            // Merge back
            txnsToSave = txnsToSave.map(t => {
                const found = categorized.find(c => c.id === t.id);
                return found || t;
            });
        }

        // 3. Save Everything
        saveTransactions(txnsToSave);

        // Update linked receipts status
        if (receiptIdsToUpdate.length > 0) {
            receiptIdsToUpdate.forEach(id => {
                const r = receipts.find(receipt => receipt.id === id);
                // We find the txn that linked it
                const txn = txnsToSave.find(t => t.receiptUrl === r?.url);
                if (r && txn) {
                    saveReceipt({ ...r, linkedTransactionId: txn.id });
                }
            });
        }

        if (newAccounts.length > 0) {
            const allAccounts = [...accounts];
            newAccounts.forEach(na => {
                if (!allAccounts.find(a => a.id === na.id)) allAccounts.push(na);
            });
            await replaceAllAccounts(allAccounts);
        }

        setActiveTab('ledger');
    };

    const handleUpdateTransaction = (updated: Transaction) => {
        saveTransaction(updated);
    };

    const handleDeleteTransaction = (id: string) => {
        // If transaction had a linked receipt, we must unlink the receipt
        const txn = transactions.find(t => t.id === id);
        if (txn && txn.receiptUrl) {
            const linkedReceipt = receipts.find(r => r.url === txn.receiptUrl);
            if (linkedReceipt) {
                saveReceipt({ ...linkedReceipt, linkedTransactionId: undefined });
            }
        }
        deleteTransaction(id);
    };

    const handleUpdateAccounts = async (updatedAccounts: Account[]) => {
        await replaceAllAccounts(updatedAccounts);
    };

    // Receipts Logic
    const handleAddReceipt = (receipt: Receipt) => {
        saveReceipt(receipt);
    };

    const handleDeleteReceipt = (id: string) => {
        deleteReceipt(id);
    };

    const handleLinkReceipt = (receiptId: string, transactionId: string) => {
        const receipt = receipts.find(r => r.id === receiptId);
        const txn = transactions.find(t => t.id === transactionId);

        if (receipt && txn) {
            // Update Transaction
            saveTransaction({ ...txn, receiptUrl: receipt.url });
            // Update Receipt
            saveReceipt({ ...receipt, linkedTransactionId: txn.id });
        }
    };

    const [autoMatchProgress, setAutoMatchProgress] = useState<{ current: number, total: number, message: string } | null>(null);

    const handleRunAutoMatching = async () => {
        // Initial feedback
        setAutoMatchProgress({ current: 0, total: 0, message: "Recherche de reçus..." });

        // 1. Match Receipts (Sync)
        const { processedTxns, matchedReceiptIds } = matchTransactionsWithReceipts(transactions, receipts);

        let txnsToUpdate = processedTxns;
        let hasUpdates = matchedReceiptIds.length > 0;

        // 2. Suggest Categories (Async - for uncategorized only)
        const uncategorized = txnsToUpdate.filter(t => !t.accountId);
        const totalToCategorize = uncategorized.length;

        if (totalToCategorize > 0) {
            setAutoMatchProgress({ current: 0, total: totalToCategorize, message: "Analyse IA..." });

            const categorized: Transaction[] = [];
            let completed = 0;

            // Process sequentially to update progress
            for (const t of uncategorized) {
                try {
                    // Slow down slightly to show progress if needed, or just await
                    const result = await suggestCategory(t.description, accounts);
                    if (result.accountId) {
                        categorized.push({
                            ...t,
                            accountId: result.accountId || undefined,
                            detectedMemberName: result.memberName || undefined,
                            status: TransactionStatus.REVIEW_NEEDED
                        });
                    } else {
                        categorized.push(t);
                    }
                } catch (e) {
                    console.error("Auto-match fail for " + t.id, e);
                    categorized.push(t);
                }
                completed++;
                setAutoMatchProgress({ current: completed, total: totalToCategorize, message: `IA : ${completed}/${totalToCategorize}` });
            }

            // Merge back
            txnsToUpdate = txnsToUpdate.map(t => {
                const found = categorized.find(c => c.id === t.id);
                return found || t;
            });

            // Check if any actually changed
            if (categorized.some(c => c.accountId)) hasUpdates = true;
        }

        if (hasUpdates) {
            setAutoMatchProgress({ current: 0, total: 0, message: "Sauvegarde..." });
            await saveTransactions(txnsToUpdate); // Batch update

            // Also update receipts linkage
            if (matchedReceiptIds.length > 0) {
                matchedReceiptIds.forEach(id => {
                    const r = receipts.find(receipt => receipt.id === id);
                    const txn = txnsToUpdate.find(t => t.receiptUrl === r?.url);
                    if (r && txn) {
                        saveReceipt({ ...r, linkedTransactionId: txn.id });
                    }
                });
            }
        }

        // Final "Done" state
        setAutoMatchProgress({ current: 100, total: 100, message: "Terminé !" });
        setTimeout(() => setAutoMatchProgress(null), 1000);
    };

    const handleReanalyzeAll = async () => {
        const total = transactions.length;
        if (total === 0) return;

        if (!confirm("Attention : Cette action va re-scanner TOUTES les transactions et potentiellement écraser vos catégorisations manuelles. Voulez-vous continuer ?")) {
            return;
        }

        setAutoMatchProgress({ current: 0, total: total, message: "Scan complet en cours..." });

        let completed = 0;

        for (const t of transactions) {
            try {
                const result = await suggestCategory(t.description, accounts);
                const updatedTxn = {
                    ...t,
                    accountId: result.accountId || undefined,
                    detectedMemberName: result.memberName || undefined,
                    status: TransactionStatus.REVIEW_NEEDED
                };
                saveTransaction(updatedTxn);
            } catch (e) {
                console.error("Re-analyze fail for " + t.id, e);
            }
            completed++;
            setAutoMatchProgress({ current: completed, total: total, message: `Re-Scan : ${completed}/${total}` });
        }

        setAutoMatchProgress({ current: total, total: total, message: "Scan Terminé !" });
        setTimeout(() => setAutoMatchProgress(null), 2000);
    };

    const handleClearAllTransactions = async () => {
        if (!confirm("ATTENTION : Vous êtes sur le point de supprimer DÉFINITIVEMENT toutes les transactions.\n\nCette action est irréversible. Voulez-vous continuer ?")) {
            return;
        }

        if (!confirm("Êtes-vous vraiment sûr ? Cela effacera toutes les transactions, ainsi que les membres détectés associés et les liens avec les justificatifs.")) {
            return;
        }

        try {
            await deleteAllTransactions();
            alert("Toutes les transactions ont été supprimées.");
        } catch (error) {
            console.error(error);
            alert("Une erreur est survenue lors de la suppression. Vérifiez la console.");
        }
    };

    const handleArchiveAllTransactions = async () => {
        const activeTransactions = transactions.filter(t => t.status !== TransactionStatus.ARCHIVED);
        if (activeTransactions.length === 0) return;

        if (!confirm(`Voulez-vous vraiment archiver ${activeTransactions.length} transactions ?\n\nElles ne seront plus visibles dans la vue par défaut mais resteront accessibles via le filtre "Archives".`)) {
            return;
        }

        // Archive all non-archived transactions
        const archived = activeTransactions.map(t => ({
            ...t,
            status: TransactionStatus.ARCHIVED
        }));

        await saveTransactions(archived);
    };

    const handleGuessMember = async (t: Transaction): Promise<string | null> => {
        try {
            const result = await suggestCategory(t.description, accounts);
            return result.memberName || null;
        } catch (e) {
            console.error("Manual AI Guess failed", e);
            return null;
        }
    };

    // Membership View Component (Keep existing code...)
    const MembersView = () => {
        const [editingTxnId, setEditingTxnId] = useState<string | null>(null);
        const [tempName, setTempName] = useState("");
        const [reconciliationData, setReconciliationData] = useState<any[] | null>(null);
        const fileInputRef = useRef<HTMLInputElement>(null);

        const membershipAccounts = accounts.filter(a => a.isMembership);

        const startEdit = (txn: Transaction) => {
            setEditingTxnId(txn.id);
            setTempName(txn.detectedMemberName || "");
        };

        const saveEdit = (originalTxn: Transaction) => {
            handleUpdateTransaction({
                ...originalTxn,
                detectedMemberName: tempName
            });
            setEditingTxnId(null);
        };

        const cancelEdit = () => {
            setEditingTxnId(null);
            setTempName("");
        };

        const handleExport = () => {
            const data: any[] = [];
            membershipAccounts.forEach(acc => {
                const txns = transactions.filter(t => t.accountId === acc.id && t.amount > 0);
                txns.forEach(t => {
                    data.push({
                        "Compte": acc.label,
                        "Date Paiement": t.date,
                        "Membre Détecté": t.detectedMemberName || "Inconnu",
                        "Montant": t.amount,
                        "Statut": "PAYÉ"
                    });
                });
            });

            if (data.length === 0) {
                alert("Aucune donnée de paiement à exporter.");
                return;
            }

            const ws = XLSX.utils.json_to_sheet(data);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Paiements Reçus");
            XLSX.writeFile(wb, "Suivi_Membres_Paiements.xlsx");
        };

        const handleImportCheck = (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (evt) => {
                try {
                    const bstr = evt.target?.result;
                    const wb = XLSX.read(bstr, { type: 'binary' });
                    const wsname = wb.SheetNames[0];
                    const ws = wb.Sheets[wsname];
                    const data = XLSX.utils.sheet_to_json(ws);

                    if (data.length === 0) {
                        alert("Le fichier semble vide.");
                        return;
                    }

                    const allPayments = transactions
                        .filter(t => t.amount > 0 && accounts.find(a => a.id === t.accountId)?.isMembership)
                        .map(t => ({
                            name: (t.detectedMemberName || "").toLowerCase().trim(),
                            amount: t.amount,
                            date: t.date,
                            originalName: t.detectedMemberName
                        }));

                    const results: any[] = data.map((row: any) => {
                        const name = row['Nom'] || row['Name'] || row['Membre'] || row['Adhérent'] || Object.values(row)[0];
                        if (!name || typeof name !== 'string') return null;

                        const cleanName = name.toLowerCase().trim();
                        const payment = allPayments.find(p => p.name === cleanName || p.name.includes(cleanName) || cleanName.includes(p.name));

                        return {
                            name: name,
                            expectedAmount: row['Montant'] || row['Amount'] || row['Cotisation'] || 'N/A',
                            paidAmount: payment ? payment.amount : 0,
                            paidDate: payment ? payment.date : null,
                            status: payment ? 'OK' : 'KO'
                        };
                    }).filter(r => r !== null);

                    setReconciliationData(results);

                } catch (err) {
                    console.error(err);
                    alert("Erreur lors de la lecture du fichier Excel. Vérifiez le format.");
                }
            };
            reader.readAsBinaryString(file);
            if (fileInputRef.current) fileInputRef.current.value = "";
        };

        return (
            <div className="p-8">
                <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
                    <div>
                        <h2 className="text-2xl font-bold text-slate-100">Suivi des Cotisations</h2>
                        <p className="text-slate-400 mt-1">Gérez les paiements membres et identifiez les retards.</p>
                    </div>
                    <div className="flex gap-2">
                        {reconciliationData ? (
                            <button
                                onClick={() => setReconciliationData(null)}
                                className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors text-sm font-medium"
                            >
                                <RefreshCw size={16} />
                                Retour liste standard
                            </button>
                        ) : (
                            <>
                                <button
                                    onClick={handleExport}
                                    className="flex items-center gap-2 px-4 py-2 bg-emerald-900/30 text-emerald-400 border border-emerald-800/50 rounded-lg hover:bg-emerald-900/50 transition-colors text-sm font-medium"
                                >
                                    <Download size={16} />
                                    Exporter Liste (Excel)
                                </button>
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors text-sm font-medium shadow-lg shadow-blue-900/20"
                                >
                                    <FileSpreadsheet size={16} />
                                    Vérifier Impayés (Import Excel)
                                </button>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    className="hidden"
                                    accept=".xlsx, .xls"
                                    onChange={handleImportCheck}
                                />
                            </>
                        )}
                    </div>
                </header>
                {/* Same content as before for the table... */}
                {/* To keep file shorter, I am assuming the table content remains identical to previous version, it's just inside a sub-component */}
                {reconciliationData ? (
                    <div className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
                        {/* Reconciliation Table Code */}
                        <div className="p-4 bg-slate-950 border-b border-slate-800 flex justify-between items-center">
                            <h3 className="font-bold text-slate-200 flex items-center gap-2">
                                <CheckCircle className="text-blue-500" size={18} />
                                Rapport de Réconciliation
                            </h3>
                            <div className="flex gap-4 text-sm">
                                <span className="text-emerald-400 font-medium">
                                    {reconciliationData.filter(r => r.status === 'OK').length} Payés
                                </span>
                                <span className="text-rose-400 font-medium">
                                    {reconciliationData.filter(r => r.status === 'KO').length} Impayés
                                </span>
                            </div>
                        </div>
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-900 border-b border-slate-800 text-xs uppercase text-slate-500">
                                <tr>
                                    <th className="px-6 py-3 font-semibold">Membre (Fichier Importé)</th>
                                    <th className="px-6 py-3 font-semibold">Montant Attendu</th>
                                    <th className="px-6 py-3 font-semibold">Paiement Trouvé</th>
                                    <th className="px-6 py-3 font-semibold">Date</th>
                                    <th className="px-6 py-3 font-semibold text-right">Statut</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                                {reconciliationData.map((row, idx) => (
                                    <tr key={idx} className={row.status === 'OK' ? 'bg-emerald-900/5 hover:bg-emerald-900/10' : 'bg-rose-900/5 hover:bg-rose-900/10'}>
                                        <td className="px-6 py-3 font-medium text-slate-200">{row.name}</td>
                                        <td className="px-6 py-3 text-slate-400">{row.expectedAmount}</td>
                                        <td className={`px-6 py-3 font-bold ${row.paidAmount > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                                            {row.paidAmount > 0 ? `CHF ${row.paidAmount}` : '-'}
                                        </td>
                                        <td className="px-6 py-3 text-slate-400">{row.paidDate || '-'}</td>
                                        <td className="px-6 py-3 text-right">
                                            {row.status === 'OK' ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-900/30 text-emerald-400 border border-emerald-800 text-xs font-bold">
                                                    <CheckCircle size={12} /> PAYÉ
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-rose-900/30 text-rose-400 border border-rose-800 text-xs font-bold">
                                                    <XCircle size={12} /> IMPAYÉ
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <>
                        {membershipAccounts.length === 0 ? (
                            <div className="p-12 text-center bg-slate-900 rounded-xl border border-slate-800 text-slate-500">
                                Aucun compte n'est configuré pour le suivi des payeurs. Allez dans l'onglet <b>Plan Comptable</b> pour l'activer sur les comptes de recettes (ex: Cotisations).
                            </div>
                        ) : (
                            <div className="space-y-8">
                                {membershipAccounts.map(account => {
                                    const accountTxns = transactions.filter(t => t.accountId === account.id && t.amount > 0);
                                    return (
                                        <div key={account.id} className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 overflow-hidden">
                                            <div className="p-4 bg-slate-950 border-b border-slate-800 flex justify-between items-center">
                                                <h3 className="font-bold text-slate-200 flex items-center gap-2">
                                                    <span className="bg-blue-900/30 text-blue-400 text-xs px-2 py-1 rounded-md font-mono border border-blue-800/50">{account.code}</span>
                                                    {account.label}
                                                </h3>
                                                <span className="text-xs text-slate-500">{accountTxns.length} paiements reçus</span>
                                            </div>

                                            <table className="w-full text-left text-sm">
                                                <thead className="bg-slate-900 border-b border-slate-800 text-xs uppercase text-slate-500">
                                                    <tr>
                                                        <th className="px-6 py-3 font-semibold">Nom du Membre (Détecté)</th>
                                                        <th className="px-6 py-3 font-semibold">Date Paiement</th>
                                                        <th className="px-6 py-3 font-semibold">Montant</th>
                                                        <th className="px-6 py-3 font-semibold">Statut</th>
                                                        <th className="px-6 py-3 font-semibold text-right">Action</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-slate-800">
                                                    {accountTxns.length > 0 ? accountTxns.map(t => {
                                                        const isEditing = editingTxnId === t.id;
                                                        const hasName = !!t.detectedMemberName;

                                                        return (
                                                            <tr key={t.id} className={`transition-colors ${isEditing ? 'bg-blue-900/20' : 'hover:bg-slate-800/50'}`}>
                                                                <td className="px-6 py-3 font-medium text-slate-300">
                                                                    {isEditing ? (
                                                                        <input
                                                                            autoFocus
                                                                            type="text"
                                                                            value={tempName}
                                                                            onChange={(e) => setTempName(e.target.value)}
                                                                            className="bg-slate-950 border border-blue-500 rounded px-2 py-1 text-white text-sm w-full focus:outline-none"
                                                                            placeholder="Nom du membre..."
                                                                        />
                                                                    ) : (
                                                                        hasName ? (
                                                                            t.detectedMemberName
                                                                        ) : (
                                                                            <span
                                                                                onClick={() => startEdit(t)}
                                                                                className="flex items-center gap-2 text-amber-400 cursor-pointer hover:underline"
                                                                            >
                                                                                <AlertTriangle size={14} />
                                                                                Assigner un nom
                                                                            </span>
                                                                        )
                                                                    )}
                                                                </td>
                                                                <td className="px-6 py-3 text-slate-400">{t.date}</td>
                                                                <td className="px-6 py-3 text-emerald-400 font-bold">CHF {t.amount.toFixed(2)}</td>
                                                                <td className="px-6 py-3">
                                                                    <span className="px-2 py-0.5 bg-green-900/30 text-green-400 border border-green-800 rounded-full text-xs font-bold">PAYÉ</span>
                                                                </td>
                                                                <td className="px-6 py-3 text-right">
                                                                    {isEditing ? (
                                                                        <div className="flex justify-end gap-2">
                                                                            <button onClick={() => saveEdit(t)} className="p-1 bg-blue-600 text-white rounded hover:bg-blue-500"><Save size={14} /></button>
                                                                            <button onClick={cancelEdit} className="p-1 bg-slate-700 text-slate-300 rounded hover:bg-slate-600"><X size={14} /></button>
                                                                        </div>
                                                                    ) : (
                                                                        <button onClick={() => startEdit(t)} className="text-slate-500 hover:text-blue-400 transition-colors p-1"><Edit2 size={14} /></button>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        )
                                                    }) : (
                                                        <tr><td colSpan={5} className="px-6 py-8 text-center text-slate-500 italic">Aucun paiement enregistré pour ce compte.</td></tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
            </div>
        );
    };

    const [isUploading, setIsUploading] = useState(false);

    // LOADING STATE
    if (authLoading || (user && dataLoading)) {
        return (
            <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-950 text-slate-400 gap-4">
                <Loader2 className="animate-spin text-blue-500" size={32} />
                <span>Chargement AssoCompta AI...</span>
            </div>
        );
    }

    // IF NO USER, NO GUEST MODE, AND CLOUD CONFIGURED -> SHOW LOGIN
    if (!user && !guestMode && isConfigured) {
        return <LoginView onGuestAccess={() => setGuestMode(true)} />;
    }

    return (
        <Layout activeTab={activeTab} onTabChange={setActiveTab} user={user} disabled={isUploading}>
            {(!isConfigured || guestMode) && (
                <div className="bg-orange-900/20 border-b border-orange-900/50 text-orange-200 px-4 py-2 text-xs flex items-center justify-center gap-2">
                    <CloudOff size={14} />
                    <span>{guestMode ? "Mode Invité" : "Mode Démo"}. Les données sont stockées uniquement dans votre navigateur (LocalStorage). Connectez-vous pour sauvegarder dans le cloud.</span>
                </div>
            )}

            {activeTab === 'dashboard' && <Dashboard transactions={transactions} accounts={accounts} />}

            {activeTab === 'upload' && (
                <UploadView
                    accounts={accounts}
                    transactions={transactions}
                    receipts={receipts}
                    user={user}
                    onProcessComplete={handleProcessComplete}
                    onProcessingChange={setIsUploading}
                />
            )}

            {activeTab === 'receipts' && (
                <ReceiptsView
                    receipts={receipts}
                    transactions={transactions}
                    onAddReceipt={handleAddReceipt}
                    onDeleteReceipt={handleDeleteReceipt}
                    onLinkReceipt={handleLinkReceipt}
                />
            )}

            {activeTab === 'ledger' && (
                <LedgerView
                    transactions={transactions}
                    accounts={accounts}
                    onUpdateTransaction={handleUpdateTransaction}
                    onDeleteTransaction={handleDeleteTransaction}
                    onAutoMatch={handleRunAutoMatching}
                    onReanalyzeAll={handleReanalyzeAll}
                    onClearAll={handleClearAllTransactions}
                    onArchiveAll={handleArchiveAllTransactions}
                    autoMatchProgress={autoMatchProgress}
                    onGuessMember={handleGuessMember}
                />
            )}

            {activeTab === 'members' && <MembersView />}

            {activeTab === 'expert' && (
                <ExpertChat transactions={transactions} accounts={accounts} />
            )}

            {activeTab === 'settings' && (
                <SettingsView accounts={accounts} onUpdateAccounts={handleUpdateAccounts} />
            )}

            {/* View Python removed */}
        </Layout>
    );
}

export default App;
