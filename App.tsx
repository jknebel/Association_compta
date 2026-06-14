
import React, { useState, useRef } from 'react';
import { Layout } from './frontend/components/Layout';
import { Dashboard } from './frontend/components/Dashboard';
import { UploadView } from './frontend/components/UploadView';
import { LedgerView } from './frontend/components/LedgerView';
import { ExpertChat } from './frontend/components/ExpertChat';
import { SettingsView } from './frontend/components/SettingsView';
import { JoinOrgPage } from './frontend/components/JoinOrgPage';
import { OrgSelector } from './frontend/components/OrgSelector';
import { AdminView } from './frontend/components/AdminView';
import { SuperAdminView } from './frontend/components/SuperAdminView';
import { MembersView } from './frontend/components/MembersView';

import { Account, Transaction, AccountType, Receipt, TransactionStatus } from './types';
import { Edit2, Save, X, AlertTriangle, CloudOff, Loader2, Download, Upload, CheckCircle, XCircle, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { useDataService } from './frontend/services/dataService';
import { useAuthContext, useOrgContext, useComptaContext } from './frontend/contexts/AppContext';
import * as XLSX from 'xlsx';
import { matchTransactionsWithReceipts } from './frontend/services/matchingService';
import { suggestCategory, parseBankStatementPDF } from './frontend/services/geminiService';
import { deleteFileFromStorage } from './frontend/services/storageService';
import { parseExcelLedger } from './frontend/services/excelService';

function App() {
    const [activeTab, setActiveTab] = useState('dashboard');
    const [guestMode, setGuestMode] = useState(false);
    
    // Background upload states
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<{ fileName: string, mode: 'PDF' | 'EXCEL' } | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);

    // 1. Check Authentication Status from Context
    const { user, loading: authLoading, isSuperAdmin } = useAuthContext();
    const { selectedOrg, orgRole, setSelectedOrg } = useOrgContext();
    const { selectedCompta, setSelectedCompta } = useComptaContext();

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
        deleteTransactions,
        globalAiContext,
        saveGlobalAiContext,
        closeFiscalYear
    } = useDataService(user, guestMode, selectedOrg?.id, selectedCompta?.id);

    const generateTransactionSignature = (t: Transaction): string => {
        return `${t.date}-${(t.amount || 0).toFixed(2)}-${(t.description || '').trim().toLowerCase()}`;
    };

    const handleUploadFile = async (file: File, activeMode: 'PDF' | 'EXCEL') => {
        setIsUploading(true);
        setUploadProgress({ fileName: file.name, mode: activeMode });
        setUploadError(null);

        try {
            let rawTransactions: Transaction[] = [];

            if (activeMode === 'PDF') {
                if (file.type !== 'application/pdf') {
                    throw new Error('Veuillez importer un fichier PDF.');
                }

                const reader = new FileReader();
                reader.readAsDataURL(file);

                await new Promise<void>((resolve, reject) => {
                    reader.onload = async () => {
                        const base64Data = (reader.result as string).split(',')[1];
                        try {
                            const userId = user ? user.uid : "guest";
                            const result = await parseBankStatementPDF(base64Data, accounts, transactions, userId, globalAiContext);
                            if (!result || !result.transactions) throw new Error("Échec de l'extraction des transactions.");

                            rawTransactions = result.transactions.map((t: any, idx: number) => ({
                                id: `txn-${Date.now()}-${idx}`,
                                date: t.date,
                                description: t.description,
                                amount: typeof t.amount === 'string' ? Number(t.amount.replace(',', '.')) : Number(t.amount || 0),
                                status: t.accountId ? TransactionStatus.REVIEW_NEEDED : TransactionStatus.PENDING,
                                accountId: t.accountId,
                                detectedMemberName: t.detectedMemberName,
                                fullRawText: t.fullRawText,
                                notes: undefined
                            }));
                            resolve();
                        } catch (err: any) {
                            reject(err);
                        }
                    };
                    reader.onerror = (e) => reject(e);
                });

            } else {
                rawTransactions = await parseExcelLedger(file);
            }

            console.log(`Transactions extracted (raw): ${rawTransactions.length}`);

            const existingSignatures = new Set(transactions.map(t => generateTransactionSignature(t)));

            let newUniqueTransactions = rawTransactions.filter(t => {
                const signature = generateTransactionSignature(t);
                return !existingSignatures.has(signature);
            });

            const duplicatesCount = rawTransactions.length - newUniqueTransactions.length;

            if (newUniqueTransactions.length === 0) {
                throw new Error("Toutes les transactions du fichier existent déjà.");
            }

            await handleProcessComplete(newUniqueTransactions, [], []);

            alert(`Import réussi !\n\n${newUniqueTransactions.length} transactions ajoutées.\n${duplicatesCount} doublons ignorés.`);

        } catch (err: any) {
            console.error("Upload failed", err);
            setUploadError(err.message || "Erreur de lecture du fichier.");
            alert("Erreur d'importation : " + (err.message || "Erreur lors de l'extraction."));
        } finally {
            setIsUploading(false);
            setUploadProgress(null);
        }
    };

    // Handle new transactions from Upload Agent
    const handleProcessComplete = async (newTxns: Transaction[], newAccounts: Account[], matchedReceiptIds: string[] = []) => {

        // Enforce Amount Polarity Rules: 
        // Positive Amount MUST be INCOME. Negative Amount MUST be EXPENSE.
        // Clear accountId if the backend AI mismatched it.
        let txnsToSave = newTxns.map(t => {
            if (t.accountId) {
                const acc = accounts.find(a => a.id === t.accountId) || newAccounts.find(a => a.id === t.accountId);
                if (acc) {
                    if (t.amount > 0 && acc.type !== AccountType.INCOME && acc.type !== AccountType.MIXED) {
                        console.warn(`[DEBUG] Dropping accountId ${t.accountId} for txn '${t.description}' because amount is ${t.amount} (positif) but account type is '${acc.type}'. Expected PRODUIT or MIXTE.`);
                        return { ...t, accountId: undefined };
                    }
                    if (t.amount < 0 && acc.type !== AccountType.EXPENSE && acc.type !== AccountType.MIXED) {
                        console.warn(`[DEBUG] Dropping accountId ${t.accountId} for txn '${t.description}' because amount is ${t.amount} (négatif) but account type is '${acc.type}'. Expected CHARGE or MIXTE.`);
                        return { ...t, accountId: undefined };
                    }
                }
            }
            return t;
        });

        let receiptIdsToUpdate = [...matchedReceiptIds];

        // 1. Auto-Match with Receipts (if not already done by backend, usually backend doesn't do receipt matching)
        // We match against existing receipts that are not linked
        const { processedTxns, matchedReceiptIds: newMatchedIds } = matchTransactionsWithReceipts(txnsToSave, receipts);
        txnsToSave = processedTxns;
        receiptIdsToUpdate = [...receiptIdsToUpdate, ...newMatchedIds]; // Merge potential Backend matches (if any) with Client matches

        // Helper to get valid accounts for AI suggestion
        const getValidAccounts = (t: Transaction, allAccounts: Account[]) => {
            return allAccounts.filter(a => {
                if (t.amount > 0) return a.type === AccountType.INCOME || a.type === AccountType.MIXED;
                if (t.amount < 0) return a.type === AccountType.EXPENSE || a.type === AccountType.MIXED;
                return true;
            });
        };

        // Note: We removed the frontend auto-categorization loop here because the backend 
        // /process-bank-statement endpoint now handles classification directly via LangGraph.
        // This eliminates the 20-30s UI freeze!

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
        // If the receipt was removed from the transaction, unlink it
        const old = transactions.find(t => t.id === updated.id);
        if (old && old.receiptUrl && !updated.receiptUrl) {
            const receiptToUnlink = receipts.find(r => r.url === old.receiptUrl);
            if (receiptToUnlink) {
                saveReceipt({ ...receiptToUnlink, linkedTransactionId: undefined, isAnalyzed: true });
            }
        }
        saveTransaction(updated);
    };

    const handleDeleteTransaction = async (id: string) => {
        console.log(`[App] Suppression individuelle demandée pour: ${id}`);
        // If transaction had a linked receipt, we must unlink the receipt
        const txn = transactions.find(t => t.id === id);
        if (txn && txn.receiptUrl) {
            const linkedReceipt = receipts.find(r => r.url === txn.receiptUrl);
            if (linkedReceipt) {
                console.log(`[App] Déliement du justificatif: ${linkedReceipt.fileName}`);
                await saveReceipt({ ...linkedReceipt, linkedTransactionId: undefined });
            }
        }
        await deleteTransaction(id);
    };

    const handleUpdateAccounts = async (updatedAccounts: Account[]) => {
        await replaceAllAccounts(updatedAccounts);
    };

    // Receipts Logic
    const handleAddReceipt = (receipt: Receipt) => {
        saveReceipt(receipt);
        // Auto-link transaction if the receipt was matched by AI
        if (receipt.linkedTransactionId) {
            const txn = transactions.find(t => t.id === receipt.linkedTransactionId);
            if (txn && !txn.receiptUrl) {
                const nameWithoutExt = receipt.fileName ? receipt.fileName.replace(/\.[^/.]+$/, "") : undefined;
                saveTransaction({ ...txn, receiptUrl: receipt.url, receiptFileName: nameWithoutExt });
            }
        }
    };

    const handleDeleteReceipt = async (id: string) => {
        const receipt = receipts.find(r => r.id === id);
        if (receipt) {
            // Deduplication Check: 
            // Are there any OTHER receipts using the same URL?
            const otherUsers = receipts.filter(r => r.id !== id && r.url === receipt.url);
            if (otherUsers.length === 0) {
                // No other receipt uses this file, safe to delete from storage
                await deleteFileFromStorage(receipt.url);
            } else {
                console.log(`File is shared by ${otherUsers.length} other receipt(s), skipping Storage deletion.`);
            }
        }
        deleteReceipt(id);
    };

    const handleLinkReceipt = (receiptId: string, transactionId: string) => {
        const receipt = receipts.find(r => r.id === receiptId);
        const txn = transactions.find(t => t.id === transactionId);

        if (receipt && txn) {
            // Update Transaction
            const nameWithoutExt = receipt.fileName ? receipt.fileName.replace(/\.[^/.]+$/, "") : undefined;
            saveTransaction({ ...txn, receiptUrl: receipt.url, receiptFileName: nameWithoutExt });
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

        // Helper to get valid accounts for AI suggestion
        const getValidAccounts = (t: Transaction, allAccounts: Account[]) => {
            return allAccounts.filter(a => {
                if (t.amount > 0) return a.type === AccountType.INCOME || a.type === AccountType.MIXED;
                if (t.amount < 0) return a.type === AccountType.EXPENSE || a.type === AccountType.MIXED;
                return true;
            });
        };

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
                    const validAccounts = getValidAccounts(t, accounts);
                    const result = await suggestCategory(t.description, validAccounts, t.fullRawText, t.receiptFileName);
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

        // Helper to get valid accounts for AI suggestion
        const getValidAccounts = (t: Transaction, allAccounts: Account[]) => {
            return allAccounts.filter(a => {
                if (t.amount > 0) return a.type === AccountType.INCOME || a.type === AccountType.MIXED;
                if (t.amount < 0) return a.type === AccountType.EXPENSE || a.type === AccountType.MIXED;
                return true;
            });
        };

        for (const t of transactions) {
            try {
                const validAccounts = getValidAccounts(t, accounts);
                const result = await suggestCategory(t.description, validAccounts, t.fullRawText, t.receiptFileName);
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

    const handleClearTransactions = async (ids?: string[]) => {
        const idsToDelete = ids || transactions.map(t => t.id);
        const count = idsToDelete.length;
        if (count === 0) return;

        const msg = ids 
            ? `Voulez-vous vraiment supprimer les ${count} transactions sélectionnées/filtrées ?`
            : "ATTENTION : Vous êtes sur le point de supprimer DÉFINITIVEMENT toutes les transactions.";
        
        if (!confirm(msg)) return;

        console.log(`[App] Lancement de la suppression groupée (simulation de ${count} clics sur la croix)`);

        try {
            // Suppression séquentielle pour imiter les clics individuels
            for (const id of idsToDelete) {
                await handleDeleteTransaction(id);
            }
            console.log(`[App] Suppression groupée terminée.`);
        } catch (error) {
            console.error("Erreur lors de la suppression groupée:", error);
            alert("Une erreur est survenue pendant la suppression. Vérifiez la console.");
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
            // Helper to get valid accounts for AI suggestion
            const getValidAccounts = (t: Transaction, allAccounts: Account[]) => {
                return allAccounts.filter(a => {
                    if (t.amount > 0) return a.type === AccountType.INCOME || a.type === AccountType.MIXED;
                    if (t.amount < 0) return a.type === AccountType.EXPENSE || a.type === AccountType.MIXED;
                    return true;
                });
            };
            const validAccounts = getValidAccounts(t, accounts);
            const result = await suggestCategory(t.description, validAccounts);
            return result.memberName || null;
        } catch (e) {
            console.error("Manual AI Guess failed", e);
            return null;
        }
    };

    // LOADING STATE
    if (authLoading || (user && selectedOrg && selectedCompta && dataLoading)) {
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

    if (user && !guestMode) {
        const params = new URLSearchParams(window.location.search);
        const joinOrgId = params.get('org');
        const inviteCode = params.get('code');
        if (joinOrgId && inviteCode) {
            return <JoinOrgPage orgId={joinOrgId} inviteCode={inviteCode} onSuccess={() => window.location.href = '/'} />;
        }

        if (isSuperAdmin && window.location.hash === '#superadmin') {
            return <SuperAdminView />;
        }

        if (!selectedOrg) {
            return <OrgSelector />;
        }

        if (selectedOrg && !selectedCompta && orgRole !== 'admin') {
            return <OrgSelector />;
        }
    }

    return (
        <Layout activeTab={activeTab} onTabChange={setActiveTab} user={user}>
            {(!isConfigured || guestMode) && (
                <div className="bg-orange-900/20 border-b border-orange-900/50 text-orange-200 px-4 py-2 text-xs flex items-center justify-center gap-2">
                    <CloudOff size={14} />
                    <span>{guestMode ? "Mode Invité" : "Mode Démo"}. Les données sont stockées uniquement dans votre navigateur (LocalStorage). Connectez-vous pour sauvegarder dans le cloud.</span>
                </div>
            )}

            {isUploading && uploadProgress && (
                <div className="fixed bottom-6 right-6 bg-slate-900 border border-slate-800 text-white rounded-xl shadow-2xl p-4 flex items-center gap-4 z-50 animate-in slide-in-from-bottom-5 duration-300">
                    <Loader2 className="animate-spin text-blue-500 shrink-0" size={20} />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-100">Traitement en arrière-plan...</p>
                        <p className="text-xs text-slate-400 truncate max-w-[220px]">{uploadProgress.fileName}</p>
                    </div>
                </div>
            )}

            {activeTab === 'dashboard' && (
                <Dashboard 
                    transactions={transactions} 
                    accounts={accounts} 
                    onUpdateAccount={saveAccount} 
                    onNavigate={setActiveTab}
                />
            )}

            {activeTab === 'upload' && (
                <UploadView
                    accounts={accounts}
                    transactions={transactions}
                    receipts={receipts}
                    user={user}
                    onProcessComplete={handleProcessComplete}
                    onProcessingChange={setIsUploading}
                    globalContext={globalAiContext}
                    isUploading={isUploading}
                    uploadError={uploadError}
                    onUploadFile={handleUploadFile}
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
                    receipts={receipts}
                    onUpdateTransaction={handleUpdateTransaction}
                    onDeleteTransaction={handleDeleteTransaction}
                    onAutoMatch={handleRunAutoMatching}
                    onReanalyzeAll={handleReanalyzeAll}
                    onClearAll={handleClearTransactions}
                    onArchiveAll={handleArchiveAllTransactions}
                    autoMatchProgress={autoMatchProgress}
                    onGuessMember={handleGuessMember}
                    onAddReceipt={handleAddReceipt}
                    onCloseFiscalYear={closeFiscalYear}
                />
            )}

            {activeTab === 'members' && (
                <MembersView 
                    accounts={accounts}
                    transactions={transactions}
                    onUpdateTransaction={handleUpdateTransaction}
                />
            )}

            {activeTab === 'admin' && (
                <AdminView />
            )}

            {activeTab === 'expert' && (
                <ExpertChat transactions={transactions} accounts={accounts} />
            )}

            {activeTab === 'settings' && (
                <SettingsView 
                    accounts={accounts} 
                    onUpdateAccounts={handleUpdateAccounts} 
                    globalContext={globalAiContext}
                    onSaveContext={saveGlobalAiContext}
                />
            )}

            {/* View Python removed */}
        </Layout>
    );
}

export default App;
