import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, Printer, CheckCircle, AlertTriangle, FileText, Bot, Archive, Loader2, Calendar, RefreshCw, Sparkles, Check } from 'lucide-react';
import { Transaction, Account, AccountType, TransactionStatus } from '../../types';
import { useAuthContext, useOrgContext, useComptaContext } from '../contexts/AppContext';
import { suggestNextComptaName, closeAndRolloverComptabilite } from '../services/organizationService';

interface AuditModalProps {
    isOpen: boolean;
    onClose: () => void;
    report: string;
    loading: boolean;
    transactions: Transaction[];
    accounts: Account[];
    onCloseFiscalYear: (finalAccounts: Account[], transactionsToArchive: Transaction[]) => Promise<void>;
    onRunAudit?: () => Promise<void> | void;
    onUpdateAccount?: (account: Account) => Promise<void> | void;
}

export const AuditModal: React.FC<AuditModalProps> = ({
    isOpen,
    onClose,
    report,
    loading,
    transactions,
    accounts,
    onCloseFiscalYear,
    onRunAudit,
    onUpdateAccount
}) => {
    const { user } = useAuthContext();
    const { selectedOrg } = useOrgContext();
    const { selectedCompta, setSelectedCompta, setComptaRole } = useComptaContext();

    const [activeTab, setActiveTab] = useState<'REPORT' | 'AUDIT' | 'CLOSING'>('REPORT');
    const [printSection, setPrintSection] = useState<'ALL' | 'BILAN' | 'JOURNAL'>('ALL');
    const [includeReceiptsInPrint, setIncludeReceiptsInPrint] = useState(false);
    const [isClosing, setIsClosing] = useState(false);

    // Rollover / Iteration state
    const [closingDate, setClosingDate] = useState(() => new Date().toISOString().split('T')[0]);
    const [baseName, setBaseName] = useState('');
    const [nextPeriod, setNextPeriod] = useState('');
    const [nextComptaName, setNextComptaName] = useState('');
    const [customNameEdited, setCustomNameEdited] = useState(false);
    const [carryOverBalance, setCarryOverBalance] = useState<number>(0);

    // Editable target closing balances per treasury account id
    const [targetBalances, setTargetBalances] = useState<Record<string, string>>({});

    const activeTransactions = transactions.filter(t => t.status !== TransactionStatus.ARCHIVED);
    const primaryAssetAccount = accounts.find(a => a.type === AccountType.ASSET);
    const openingBankBalance = Number(primaryAssetAccount?.initialBalance || 0);
    const totalMovements = activeTransactions.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const calculatedClosingBalance = Math.round((openingBankBalance + totalMovements) * 100) / 100;

    // Treasury accounts to display in the closing balance check (only ASSET / LIABILITY, never income/expense categories!)
    const treasuryAccounts = accounts.filter(a => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY);

    useEffect(() => {
        if (isOpen) {
            const currentComptaName = selectedCompta?.name || 'Groupe';
            const suggestion = suggestNextComptaName(currentComptaName);
            setClosingDate(new Date().toISOString().split('T')[0]);
            setBaseName(suggestion.baseName);
            setNextPeriod(suggestion.suggestedNextPeriod);
            setNextComptaName(suggestion.suggestedFullName);
            setCustomNameEdited(false);

            const initialTargetMap: Record<string, string> = {};
            accounts
                .filter(a => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY)
                .forEach(acc => {
                    const isPrimary = primaryAssetAccount && acc.id === primaryAssetAccount.id;
                    const mov = isPrimary
                        ? totalMovements
                        : activeTransactions.filter(t => t.accountId === acc.id).reduce((sum, t) => sum + t.amount, 0);
                    const calc = Math.round(((acc.initialBalance || 0) + mov) * 100) / 100;
                    const existingTarget = acc.closingBalance !== undefined ? acc.closingBalance : calc;
                    initialTargetMap[acc.id] = existingTarget.toFixed(2);
                });
            setTargetBalances(initialTargetMap);

            const initialCarry =
                primaryAssetAccount?.closingBalance !== undefined
                    ? Number(primaryAssetAccount.closingBalance)
                    : calculatedClosingBalance;
            setCarryOverBalance(Math.round(initialCarry * 100) / 100);
        }
    }, [isOpen, selectedCompta?.name]);

    if (!isOpen) return null;

    const handlePeriodChange = (val: string) => {
        setNextPeriod(val);
        if (!customNameEdited) {
            setNextComptaName(val.trim() ? `${baseName} ${val.trim()}`.trim() : baseName);
        }
    };

    const handlePrintMode = (mode: 'ALL' | 'BILAN' | 'JOURNAL') => {
        setPrintSection(mode);
        setTimeout(() => {
            window.print();
        }, 100);
    };

    const handleTargetBalanceChange = (acc: Account, rawValue: string, isPrimary: boolean) => {
        setTargetBalances(prev => ({ ...prev, [acc.id]: rawValue }));
        const parsed = parseFloat(rawValue.replace(',', '.'));
        if (!isNaN(parsed) && isPrimary) {
            setCarryOverBalance(Math.round(parsed * 100) / 100);
        }
    };

    const handleTargetBalanceBlur = (acc: Account) => {
        const rawValue = targetBalances[acc.id];
        const parsed = rawValue !== undefined && rawValue !== '' ? parseFloat(rawValue.replace(',', '.')) : undefined;
        const cleanVal = parsed !== undefined && !isNaN(parsed) ? Math.round(parsed * 100) / 100 : undefined;
        if (onUpdateAccount && cleanVal !== acc.closingBalance) {
            onUpdateAccount({ ...acc, closingBalance: cleanVal });
        }
    };

    const handleConfirmCloseFiscalYear = async () => {
        if (!nextComptaName.trim()) {
            alert("Veuillez renseigner le nom de la nouvelle comptabilité.");
            return;
        }
        if (!window.confirm(
            `Confirmer la clôture de "${selectedCompta?.name || 'cet exercice'}" au ${closingDate} ?\n\n` +
            `- "${selectedCompta?.name || 'Cet exercice'}" sera archivé.\n` +
            `- La nouvelle comptabilité "${nextComptaName}" sera créée avec un solde initial de CHF ${Number(carryOverBalance || 0).toFixed(2)}.`
        )) return;

        setIsClosing(true);
        try {
            if (selectedOrg && selectedCompta && user) {
                const newCompta = await closeAndRolloverComptabilite({
                    orgId: selectedOrg.id,
                    oldComptaId: selectedCompta.id,
                    newComptaName: nextComptaName.trim(),
                    closingDate: closingDate || new Date().toISOString().split('T')[0],
                    carryOverBalance: Number(carryOverBalance || 0),
                    creatorUid: user.uid,
                    overrideAccounts: accounts
                });
                setSelectedCompta(newCompta);
                setComptaRole('caissier' as any);
                alert(`Clôture effectuée ! La comptabilité "${selectedCompta.name}" a été archivée et vous êtes maintenant sur "${newCompta.name}" avec un solde d'ouverture de CHF ${Number(carryOverBalance || 0).toFixed(2)}.`);
                onClose();
            } else {
                // Fallback mode local / invité
                let assetHandled = false;
                const finalAccounts = accounts.map(acc => {
                    if (acc.type === AccountType.ASSET && !assetHandled) {
                        assetHandled = true;
                        return {
                            ...acc,
                            initialBalance: Number(carryOverBalance || 0),
                            closingBalance: undefined
                        };
                    }
                    return {
                        ...acc,
                        initialBalance: acc.type === AccountType.LIABILITY ? (acc.initialBalance || 0) : 0,
                        closingBalance: undefined
                    };
                });
                await onCloseFiscalYear(finalAccounts, activeTransactions);
                alert("Clôture effectuée avec succès ! L'application redémarre sur le nouvel exercice.");
                onClose();
            }
        } catch (e) {
            console.error(e);
            alert("Erreur lors de la clôture.");
        } finally {
            setIsClosing(false);
        }
    };

    // --- LOGIQUE DE GÉNÉRATION DU RAPPORT DE CLÔTURE ---

    // 1. Calcul du Bilan / Compte de Résultat (avec libellé parent > sous-compte si pertinent)
    const getAccountDisplayLabel = (account?: Account) => {
        if (!account) return 'Non catégorisé';
        if (account.parentId) {
            const parent = accounts.find(p => p.id === account.parentId);
            if (parent) {
                return `${parent.label} › ${account.label}`;
            }
        }
        return account.label;
    };

    const charges = activeTransactions
        .filter(t => t.amount < 0)
        .reduce((acc, t) => {
            const account = accounts.find(a => a.id === t.accountId);
            const code = account ? account.code : 'Inconnu';
            const label = getAccountDisplayLabel(account);

            if (!acc[code]) acc[code] = { label, amount: 0 };
            acc[code].amount += Math.abs(t.amount);
            return acc;
        }, {} as Record<string, { label: string; amount: number }>);

    const produits = activeTransactions
        .filter(t => t.amount > 0)
        .reduce((acc, t) => {
            const account = accounts.find(a => a.id === t.accountId);
            const code = account ? account.code : 'Inconnu';
            const label = getAccountDisplayLabel(account);

            if (!acc[code]) acc[code] = { label, amount: 0 };
            acc[code].amount += t.amount;
            return acc;
        }, {} as Record<string, { label: string; amount: number }>);

    const totalCharges = Object.values(charges).reduce((sum, c) => sum + c.amount, 0);
    const totalProduits = Object.values(produits).reduce((sum, p) => sum + p.amount, 0);
    const resultat = totalProduits - totalCharges;

    // 2. Journal pour l'impression (Trié par date)
    const sortedTransactions = [...activeTransactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto print:p-0 print:bg-white print:static print:block print:overflow-visible">
            <div className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] md:h-[90vh] flex flex-col overflow-hidden print:block print:shadow-none print:h-auto print:max-h-none print:w-full print:max-w-none print:rounded-none print:overflow-visible">

                {/* Header (Écran uniquement) */}
                <div className="p-4 md:p-6 bg-slate-50 border-b border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 print:hidden">
                    <div className="flex items-center justify-between w-full md:w-auto">
                        <div>
                            <h2 className="text-lg sm:text-2xl font-bold text-slate-800 flex items-center gap-2">
                                <CheckCircle className="text-emerald-600" />
                                Clôture & Audit
                            </h2>
                            <p className="text-slate-500 text-xs sm:text-sm mt-1">Générez votre rapport officiel en 2 feuilles, lancez l'audit IA ou clôturez l'exercice.</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="md:hidden p-2 hover:bg-slate-200 rounded-full transition-colors"
                        >
                            <X size={22} className="text-slate-500" />
                        </button>
                    </div>

                    <div className="flex bg-slate-200 p-1 rounded-lg w-full md:w-auto overflow-x-auto">
                        <button
                            onClick={() => setActiveTab('REPORT')}
                            className={`flex-1 md:flex-initial justify-center px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${activeTab === 'REPORT' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            <FileText size={16} />
                            Rapport Comptable
                        </button>
                        <button
                            onClick={() => {
                                setActiveTab('AUDIT');
                                if (!report && !loading && onRunAudit) {
                                    onRunAudit();
                                }
                            }}
                            className={`flex-1 md:flex-initial justify-center px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${activeTab === 'AUDIT' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            <Bot size={16} />
                            Audit IA
                        </button>
                        <button
                            onClick={() => setActiveTab('CLOSING')}
                            className={`flex-1 md:flex-initial justify-center px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${activeTab === 'CLOSING' ? 'bg-white text-orange-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            <Archive size={16} />
                            Clôture & Archivage
                        </button>
                    </div>

                    <button
                        onClick={onClose}
                        className="hidden md:block p-2 hover:bg-slate-200 rounded-full transition-colors cursor-pointer"
                    >
                        <X size={24} className="text-slate-500" />
                    </button>
                </div>

                {/* Content Container */}
                <div className="flex-1 overflow-y-auto bg-white print:overflow-visible print:block">

                    {/* TAB: RAPPORT COMPTABLE (Ce qui sera imprimé) */}
                    <div className={`${activeTab === 'REPORT' ? 'block' : 'hidden'} print:block`}>
                        {/* Barre d'options d'impression (Écran uniquement) */}
                        <div className="print:hidden bg-blue-50/70 border-b border-blue-100 px-4 sm:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-bold uppercase tracking-wider text-blue-800 mr-1">Impression rapide :</span>
                                <button
                                    onClick={() => handlePrintMode('ALL')}
                                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                                >
                                    <Printer size={14} />
                                    Imprimer les 2 Feuilles (Bilan + Journal)
                                </button>
                                <button
                                    onClick={() => handlePrintMode('BILAN')}
                                    className="px-3 py-1.5 bg-white hover:bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                                >
                                    <Printer size={14} />
                                    Feuille 1 : Charges & Produits
                                </button>
                                <button
                                    onClick={() => handlePrintMode('JOURNAL')}
                                    className="px-3 py-1.5 bg-white hover:bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                                >
                                    <Printer size={14} />
                                    Feuille 2 : Journal des Écritures
                                </button>
                            </div>
                            <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={includeReceiptsInPrint}
                                    onChange={(e) => setIncludeReceiptsInPrint(e.target.checked)}
                                    className="rounded border-slate-300"
                                />
                                Inclure les pièces justificatives en annexe
                            </label>
                        </div>

                        <div className="p-4 sm:p-8 max-w-4xl mx-auto print:p-4 print:max-w-none">

                            {/* ==================== FEUILLE 1 : BILAN / CHARGES & PRODUITS ==================== */}
                            <div className={`print-section mb-8 sm:mb-12 ${printSection === 'JOURNAL' ? 'print:hidden' : 'print:block'}`}>
                                <header className="text-center mb-8 border-b-2 border-slate-900 pb-6">
                                    <div className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">Feuille 1 / 2 — Compte de Résultat</div>
                                    <h1 className="text-2xl sm:text-3xl font-bold uppercase tracking-wide mb-2">
                                        Rapport de Clôture {selectedCompta?.name ? `— ${selectedCompta.name}` : ''}
                                    </h1>
                                    <p className="text-slate-500 text-base sm:text-lg">
                                        {selectedOrg?.name ? `${selectedOrg.name} • ` : ''}Exercice Comptable {new Date().getFullYear()}
                                    </p>
                                    <p className="text-sm text-slate-400 mt-1">Généré le {new Date().toLocaleDateString('fr-CH')}</p>
                                </header>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 print:grid-cols-2">
                                    {/* CHARGES */}
                                    <div>
                                        <h3 className="text-xl font-bold border-b-2 border-rose-500 text-rose-700 mb-4 pb-2">CHARGES (Dépenses)</h3>
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                                                    <th className="py-1.5 text-left w-16">Code</th>
                                                    <th className="py-1.5 text-left">Compte</th>
                                                    <th className="py-1.5 text-right">Montant (CHF)</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {Object.entries(charges)
                                                    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                                                    .map(([code, data]) => (
                                                        <tr key={code} className="border-b border-slate-100">
                                                            <td className="py-2 text-slate-500 font-mono text-xs">{code}</td>
                                                            <td className="py-2 text-slate-700">{data.label}</td>
                                                            <td className="py-2 text-right font-mono font-medium">{data.amount.toFixed(2)}</td>
                                                        </tr>
                                                    ))}
                                                <tr className="bg-rose-50 font-bold text-rose-900 border-t-2 border-rose-200">
                                                    <td colSpan={2} className="py-3 px-2">TOTAL CHARGES</td>
                                                    <td className="py-3 text-right px-2 font-mono">{totalCharges.toFixed(2)}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* PRODUITS */}
                                    <div>
                                        <h3 className="text-xl font-bold border-b-2 border-emerald-500 text-emerald-700 mb-4 pb-2">PRODUITS (Recettes)</h3>
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                                                    <th className="py-1.5 text-left w-16">Code</th>
                                                    <th className="py-1.5 text-left">Compte</th>
                                                    <th className="py-1.5 text-right">Montant (CHF)</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {Object.entries(produits)
                                                    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                                                    .map(([code, data]) => (
                                                        <tr key={code} className="border-b border-slate-100">
                                                            <td className="py-2 text-slate-500 font-mono text-xs">{code}</td>
                                                            <td className="py-2 text-slate-700">{data.label}</td>
                                                            <td className="py-2 text-right font-mono font-medium">{data.amount.toFixed(2)}</td>
                                                        </tr>
                                                    ))}
                                                <tr className="bg-emerald-50 font-bold text-emerald-900 border-t-2 border-emerald-200">
                                                    <td colSpan={2} className="py-3 px-2">TOTAL PRODUITS</td>
                                                    <td className="py-3 text-right px-2 font-mono">{totalProduits.toFixed(2)}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* RÉSULTAT & SYNTHÈSE DE TRÉSORERIE */}
                                <div className="grid grid-cols-1 md:grid-cols-2 print:grid-cols-2 gap-6 mt-8">
                                    <div className={`p-6 rounded-lg text-center border-2 ${resultat >= 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
                                        <h3 className="text-sm font-semibold uppercase mb-1">Résultat de l'exercice</h3>
                                        <div className="text-3xl font-bold font-mono">
                                            {resultat >= 0 ? '+' : ''}{resultat.toFixed(2)} CHF
                                        </div>
                                        <p className="mt-1 text-sm font-bold">{resultat >= 0 ? 'EXCÉDENT (BÉNÉFICE)' : 'DÉFICIT (PERTE)'}</p>
                                    </div>

                                    <div className="p-6 rounded-lg border-2 border-slate-200 bg-slate-50 text-slate-800 flex flex-col justify-center">
                                        <h3 className="text-sm font-semibold uppercase text-slate-500 mb-2">Synthèse de Trésorerie</h3>
                                        <div className="space-y-1 text-sm">
                                            <div className="flex justify-between">
                                                <span className="text-slate-600">Solde d'ouverture :</span>
                                                <span className="font-mono font-medium">{openingBankBalance.toFixed(2)} CHF</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-slate-600">Variation de la période :</span>
                                                <span className="font-mono font-medium">{resultat >= 0 ? '+' : ''}{resultat.toFixed(2)} CHF</span>
                                            </div>
                                            <div className="flex justify-between pt-1.5 border-t border-slate-300 font-bold text-base">
                                                <span>Solde final de clôture :</span>
                                                <span className="font-mono">{calculatedClosingBalance.toFixed(2)} CHF</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* SAUT DE PAGE ENTRE FEUILLE 1 (CHARGES/PRODUITS) ET FEUILLE 2 (JOURNAL) */}
                            {printSection === 'ALL' && (
                                <div className="print-page-break hidden print:block"></div>
                            )}

                            {/* ==================== FEUILLE 2 : JOURNAL DES ÉCRITURES ==================== */}
                            <div className={`print-section pt-4 sm:pt-8 print:pt-0 ${printSection === 'BILAN' ? 'print:hidden' : 'print:block'}`}>
                                <header className="mb-6 pb-4 border-b-2 border-slate-900 flex flex-col sm:flex-row sm:items-end justify-between gap-2">
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">Feuille 2 / 2 — Détail des Transactions</div>
                                        <h2 className="text-2xl font-bold uppercase tracking-wide">
                                            Journal des Écritures {selectedCompta?.name ? `— ${selectedCompta.name}` : ''}
                                        </h2>
                                    </div>
                                    <div className="text-xs text-slate-500">
                                        {sortedTransactions.length} écritures • Généré le {new Date().toLocaleDateString('fr-CH')}
                                    </div>
                                </header>

                                <table className="w-full text-xs sm:text-sm text-left border-collapse">
                                    <thead className="bg-slate-100 text-slate-700 font-semibold uppercase text-xs border-b-2 border-slate-300">
                                        <tr>
                                            <th className="px-3 py-2.5">Date</th>
                                            <th className="px-3 py-2.5">Code</th>
                                            <th className="px-3 py-2.5">Compte / Sous-compte</th>
                                            <th className="px-3 py-2.5">Libellé</th>
                                            <th className="px-3 py-2.5 text-right">Débit (-)</th>
                                            <th className="px-3 py-2.5 text-right">Crédit (+)</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {sortedTransactions.map((t) => {
                                            const account = accounts.find(a => a.id === t.accountId);
                                            return (
                                                <tr key={t.id} className="hover:bg-slate-50 print-avoid-break">
                                                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 font-mono text-xs">{t.date}</td>
                                                    <td className="px-3 py-2 font-mono text-slate-700 text-xs font-semibold">{account?.code || '-'}</td>
                                                    <td className="px-3 py-2 text-slate-600 text-xs">{getAccountDisplayLabel(account)}</td>
                                                    <td className="px-3 py-2 text-slate-800 max-w-[280px] break-words">{t.description}</td>
                                                    <td className="px-3 py-2 text-right font-mono text-rose-700 bg-rose-50/30">
                                                        {t.amount < 0 ? Math.abs(t.amount).toFixed(2) : '-'}
                                                    </td>
                                                    <td className="px-3 py-2 text-right font-mono text-emerald-700 bg-emerald-50/30">
                                                        {t.amount > 0 ? t.amount.toFixed(2) : '-'}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                    <tfoot>
                                        <tr className="bg-slate-100 font-bold text-slate-900 border-t-2 border-slate-400">
                                            <td colSpan={4} className="px-3 py-3 text-right uppercase text-xs">Totaux du Journal :</td>
                                            <td className="px-3 py-3 text-right font-mono text-rose-700">{totalCharges.toFixed(2)}</td>
                                            <td className="px-3 py-3 text-right font-mono text-emerald-700">{totalProduits.toFixed(2)}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>

                            {/* ANNEXES OPTIONNELLES : PIÈCES JUSTIFICATIVES */}
                            {includeReceiptsInPrint && (
                                <>
                                    <div className="print-page-break hidden print:block"></div>
                                    <div className="print-section pt-8">
                                        <h2 className="text-2xl font-bold mb-6 pb-2 border-b border-slate-300">Annexes : Pièces Justificatives</h2>
                                        <div className="space-y-12">
                                            {sortedTransactions.filter(t => t.receiptUrl).map((t) => (
                                                <div key={t.id} id={`receipt-${t.id}`} className="print-avoid-break mb-12 border rounded-lg p-4 bg-slate-50 print:bg-white print:border-slate-200">
                                                    <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-200">
                                                        <div>
                                                            <h4 className="font-bold text-slate-800">{t.date} — {Math.abs(t.amount).toFixed(2)} CHF</h4>
                                                            <p className="text-sm text-slate-500">{t.description}</p>
                                                        </div>
                                                        <span className="bg-slate-200 text-slate-600 text-xs px-2 py-1 rounded">Réf: {t.id.slice(0, 8)}</span>
                                                    </div>
                                                    <div className="flex justify-center bg-white border border-slate-200 rounded p-2">
                                                        {t.receiptUrl?.toLowerCase().endsWith('.pdf') ? (
                                                            <iframe src={t.receiptUrl} className="w-full h-[600px] border-none" title={`Justificatif ${t.id}`} />
                                                        ) : (
                                                            <img src={t.receiptUrl} alt="Justificatif" className="max-h-[800px] object-contain" />
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                            {sortedTransactions.filter(t => t.receiptUrl).length === 0 && (
                                                <p className="text-slate-500 italic text-center py-8">Aucune pièce justificative jointe.</p>
                                            )}
                                        </div>
                                    </div>
                                </>
                            )}

                        </div>
                    </div>

                    {/* ==================== TAB: AUDIT IA ==================== */}
                    <div className={`${activeTab === 'AUDIT' ? 'block' : 'hidden'} print:hidden p-6 sm:p-8`}>
                        <div className="max-w-4xl mx-auto">
                            <div className="mb-6 p-4 bg-purple-50 border border-purple-200 rounded-xl text-sm text-purple-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                <div className="flex items-start gap-3">
                                    <Bot size={22} className="shrink-0 mt-0.5 text-purple-700" />
                                    <div>
                                        <p className="font-bold mb-0.5 text-purple-900">Analyse de l'Assistant IA</p>
                                        <p className="text-purple-700 text-xs sm:text-sm">
                                            Analyse automatique de vos écritures pour détecter d'éventuelles anomalies (doublons, sens d'écriture, pièces manquantes). Elle ne figure pas sur le rapport officiel imprimé.
                                        </p>
                                    </div>
                                </div>
                                {onRunAudit && (
                                    <button
                                        onClick={() => onRunAudit()}
                                        disabled={loading}
                                        className="px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white rounded-lg font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 shrink-0 shadow-md shadow-purple-500/20 transition-all cursor-pointer"
                                    >
                                        {loading ? (
                                            <>
                                                <Loader2 size={16} className="animate-spin" />
                                                Analyse en cours...
                                            </>
                                        ) : (
                                            <>
                                                <RefreshCw size={16} />
                                                {report ? "Relancer l'Audit IA" : "Lancer l'Audit IA"}
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>

                            {loading ? (
                                <div className="flex flex-col items-center justify-center h-64 gap-4 bg-slate-50 rounded-xl border border-slate-200">
                                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
                                    <p className="text-slate-600 font-medium animate-pulse">L'expert IA analyse vos {activeTransactions.length} écritures...</p>
                                </div>
                            ) : report ? (
                                <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 prose prose-slate max-w-none">
                                    <ReactMarkdown>{report}</ReactMarkdown>
                                </div>
                            ) : (
                                <div className="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300 flex flex-col items-center gap-4">
                                    <Sparkles size={36} className="text-purple-500" />
                                    <div>
                                        <h4 className="font-bold text-slate-800 text-base">Prêt à analyser votre comptabilité</h4>
                                        <p className="text-sm text-slate-500 max-w-md mt-1">
                                            Cliquez sur le bouton ci-dessous pour générer le rapport d'audit complet de vos {activeTransactions.length} transactions.
                                        </p>
                                    </div>
                                    {onRunAudit && (
                                        <button
                                            onClick={() => onRunAudit()}
                                            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold text-sm flex items-center gap-2 shadow-lg shadow-purple-500/20 transition-all cursor-pointer"
                                        >
                                            <Sparkles size={18} />
                                            Lancer l'Audit IA maintenant
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ==================== TAB: CLÔTURE & ARCHIVAGE ==================== */}
                    <div className={`${activeTab === 'CLOSING' ? 'block' : 'hidden'} print:hidden p-4 sm:p-8`}>
                        <div className="max-w-4xl mx-auto space-y-6">
                            <div className="bg-orange-50 border border-orange-200 p-4 rounded-xl flex gap-4 text-orange-900">
                                <AlertTriangle className="shrink-0 text-orange-600 mt-0.5" />
                                <div>
                                    <h4 className="font-bold">Contrôle de Fin d'Exercice & Passage à l'Année Suivante</h4>
                                    <p className="text-sm text-orange-800 mt-0.5">
                                        Vérifiez le solde final de votre compte bancaire, renseignez les paramètres du nouvel exercice ci-dessous, puis cliquez sur <strong>« Clôturer & Créer »</strong> pour archiver <strong>{selectedCompta?.name || 'cet exercice'}</strong> ({activeTransactions.length} écritures) et créer automatiquement l'exercice suivant.
                                    </p>
                                </div>
                            </div>

                            {/* 1. Contrôle du Solde Bancaire (Uniquement les comptes de Bilan : Actif / Passif) */}
                            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2">
                                    <div>
                                        <h4 className="font-bold text-slate-800 text-sm">1. Vérification du Solde Bancaire de Clôture</h4>
                                        <p className="text-xs text-slate-500">Saisissez le solde final indiqué sur votre relevé bancaire pour vérifier qu'il n'y a aucun écart.</p>
                                    </div>
                                </div>
                                <div className="overflow-x-auto p-4">
                                    <table className="w-full text-left border-collapse min-w-[520px]">
                                        <thead>
                                            <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 font-bold">
                                                <th className="py-2.5">Compte de Trésorerie</th>
                                                <th className="py-2.5 text-right">Solde Calculé</th>
                                                <th className="py-2.5 text-right">Solde de Clôture Cible (Relevé)</th>
                                                <th className="py-2.5 text-right">Écart</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {treasuryAccounts.length > 0 ? (
                                                treasuryAccounts.map(acc => {
                                                    const isPrimaryAsset = Boolean(primaryAssetAccount && acc.id === primaryAssetAccount.id);
                                                    const movements = isPrimaryAsset
                                                        ? totalMovements
                                                        : activeTransactions.filter(t => t.accountId === acc.id).reduce((sum, t) => sum + t.amount, 0);
                                                    const calculated = Math.round(((acc.initialBalance || 0) + movements) * 100) / 100;
                                                    const rawTarget = targetBalances[acc.id] ?? '';
                                                    const parsedTarget = rawTarget !== '' ? parseFloat(rawTarget.replace(',', '.')) : NaN;
                                                    const gap = !isNaN(parsedTarget) ? Math.round((calculated - parsedTarget) * 100) / 100 : null;

                                                    return (
                                                        <tr key={acc.id} className="border-b border-slate-100 last:border-none">
                                                            <td className="py-3">
                                                                <div className="font-bold text-slate-800">{acc.label}</div>
                                                                <div className="text-xs text-slate-500 font-mono">
                                                                    {acc.code} • Ouverture: {(acc.initialBalance || 0).toFixed(2)} CHF | Mouvements: {movements >= 0 ? '+' : ''}{movements.toFixed(2)} CHF
                                                                </div>
                                                            </td>
                                                            <td className="py-3 text-right font-mono font-bold text-slate-800">
                                                                {calculated.toLocaleString('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CHF
                                                            </td>
                                                            <td className="py-3 text-right">
                                                                <div className="inline-flex items-center justify-end gap-1.5">
                                                                    <input
                                                                        type="number"
                                                                        step="0.01"
                                                                        value={rawTarget}
                                                                        onChange={(e) => handleTargetBalanceChange(acc, e.target.value, isPrimaryAsset)}
                                                                        onBlur={() => handleTargetBalanceBlur(acc)}
                                                                        placeholder={calculated.toFixed(2)}
                                                                        className="w-32 border border-slate-300 focus:border-blue-600 rounded-lg px-2.5 py-1.5 text-right font-mono font-bold text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                                                    />
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            const formatted = calculated.toFixed(2);
                                                                            handleTargetBalanceChange(acc, formatted, isPrimaryAsset);
                                                                            if (onUpdateAccount) {
                                                                                onUpdateAccount({ ...acc, closingBalance: calculated });
                                                                            }
                                                                        }}
                                                                        className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-medium transition-colors cursor-pointer"
                                                                        title="Aligner sur le solde calculé"
                                                                    >
                                                                        = Calculé
                                                                    </button>
                                                                </div>
                                                            </td>
                                                            <td className="py-3 text-right">
                                                                {gap !== null ? (
                                                                    <span className={`inline-flex items-center gap-1 font-mono text-xs font-bold px-2.5 py-1 rounded-full ${Math.abs(gap) < 0.01 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                                                                        {Math.abs(gap) < 0.01 ? (
                                                                            <>
                                                                                <Check size={14} /> OK (0.00)
                                                                            </>
                                                                        ) : (
                                                                            `${gap > 0 ? '+' : ''}${gap.toFixed(2)} CHF`
                                                                        )}
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-slate-400 text-xs italic">À saisir</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })
                                            ) : (
                                                <tr>
                                                    <td className="py-3">
                                                        <div className="font-bold text-slate-800">Compte Bancaire Principal</div>
                                                        <div className="text-xs text-slate-500 font-mono">1020 • Mouvements de l'exercice</div>
                                                    </td>
                                                    <td className="py-3 text-right font-mono font-bold text-slate-800">
                                                        {calculatedClosingBalance.toFixed(2)} CHF
                                                    </td>
                                                    <td className="py-3 text-right">
                                                        <input
                                                            type="number"
                                                            step="0.01"
                                                            value={carryOverBalance}
                                                            onChange={(e) => setCarryOverBalance(parseFloat(e.target.value) || 0)}
                                                            className="w-32 border border-slate-300 focus:border-blue-600 rounded-lg px-2.5 py-1.5 text-right font-mono font-bold text-sm text-slate-900 focus:outline-none"
                                                        />
                                                    </td>
                                                    <td className="py-3 text-right">
                                                        <span className="inline-flex items-center gap-1 font-mono text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700">
                                                            <Check size={14} /> Prêt
                                                        </span>
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* 2. Paramètres de Clôture & Nouvel Exercice */}
                            <div className="bg-slate-100 p-4 sm:p-6 rounded-xl border border-slate-200">
                                <h4 className="font-bold text-slate-800 mb-4">2. Paramètres de Clôture & Nouvel Exercice</h4>
                                <div className="space-y-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-white p-4 rounded-xl border border-slate-200">
                                        <div>
                                            <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                                                <Calendar size={14} className="text-orange-600" />
                                                Date de clôture *
                                            </label>
                                            <input
                                                type="date"
                                                value={closingDate}
                                                onChange={(e) => setClosingDate(e.target.value)}
                                                className="w-full border border-slate-300 rounded-lg p-2.5 text-slate-900 text-sm focus:outline-none focus:border-orange-500"
                                                required
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-xs font-bold text-slate-700 mb-1">
                                                Année(s) du nouvel exercice (ex: 26/27) *
                                            </label>
                                            <input
                                                type="text"
                                                value={nextPeriod}
                                                onChange={(e) => handlePeriodChange(e.target.value)}
                                                placeholder="Ex: 26/27"
                                                className="w-full border border-orange-400 rounded-lg p-2.5 text-slate-900 text-sm font-semibold focus:outline-none focus:border-orange-600"
                                                required
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-xs font-bold text-slate-700 mb-1">
                                                Nom de la nouvelle comptabilité créée *
                                            </label>
                                            <input
                                                type="text"
                                                value={nextComptaName}
                                                onChange={(e) => {
                                                    setNextComptaName(e.target.value);
                                                    setCustomNameEdited(true);
                                                }}
                                                placeholder="Ex: Groupe 26/27"
                                                className="w-full border border-slate-300 rounded-lg p-2.5 text-slate-900 text-sm focus:outline-none focus:border-orange-500"
                                                required
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-xs font-bold text-slate-700 mb-1">
                                                Solde final reporté à l'ouverture (CHF)
                                            </label>
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={carryOverBalance}
                                                onChange={(e) => setCarryOverBalance(parseFloat(e.target.value) || 0)}
                                                className="w-full border border-slate-300 rounded-lg p-2.5 text-emerald-700 font-mono font-bold text-sm focus:outline-none focus:border-emerald-600"
                                            />
                                            <span className="text-[11px] text-slate-500 mt-0.5 block">
                                                Ouverture ({openingBankBalance.toFixed(2)}) + Mouvements ({totalMovements >= 0 ? '+' : ''}{totalMovements.toFixed(2)}) = {calculatedClosingBalance.toFixed(2)} CHF
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex items-start gap-3 text-sm text-slate-600">
                                        <CheckCircle className="text-emerald-500 shrink-0 mt-0.5" size={16} />
                                        <span>La comptabilité actuelle <strong>{selectedCompta?.name || ''}</strong> sera archivée avec ses {activeTransactions.length} écritures (consultable à tout moment dans les archives).</span>
                                    </div>
                                    <div className="flex items-start gap-3 text-sm text-slate-600">
                                        <CheckCircle className="text-emerald-500 shrink-0 mt-0.5" size={16} />
                                        <span>Une nouvelle comptabilité <strong>{nextComptaName || 'Nouvel exercice'}</strong> sera créée avec le plan comptable et un solde d'ouverture de <strong>CHF {Number(carryOverBalance || 0).toFixed(2)}</strong>.</span>
                                    </div>

                                    <div className="pt-4 border-t border-slate-200 flex flex-col items-center gap-3">
                                        <p className="text-xs text-slate-500 text-center max-w-md italic">
                                            Assurez-vous d'avoir imprimé ou sauvegardé votre rapport de clôture avant de valider.
                                        </p>
                                        <button
                                            disabled={isClosing || !nextComptaName.trim()}
                                            onClick={handleConfirmCloseFiscalYear}
                                            className={`px-6 sm:px-8 py-3 rounded-xl font-bold text-sm sm:text-base shadow-xl transition-all flex items-center gap-3 ${isClosing ? 'bg-slate-400 cursor-wait' : 'bg-gradient-to-r from-orange-500 to-rose-600 text-white hover:from-orange-600 hover:to-rose-700 shadow-orange-500/20 hover:scale-105 cursor-pointer'}`}
                                        >
                                            {isClosing ? <Loader2 className="animate-spin" /> : <Archive size={20} />}
                                            Clôturer & Créer « {nextComptaName || 'Nouvel Exercice'} »
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer (Actions) */}
                <div className="p-4 sm:p-6 bg-slate-50 border-t border-slate-200 flex flex-wrap justify-between items-center gap-3 print:hidden">
                    <div className="text-xs sm:text-sm text-slate-500">
                        {activeTransactions.length} écritures - {new Date().toLocaleDateString('fr-CH')}
                    </div>
                    <div className="flex flex-wrap gap-2 sm:gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 sm:px-6 py-2 rounded-lg text-slate-600 hover:bg-slate-200 font-medium text-xs sm:text-sm transition-colors cursor-pointer"
                        >
                            Fermer
                        </button>

                        {activeTab === 'REPORT' && (
                            <button
                                onClick={() => handlePrintMode('ALL')}
                                className="px-4 sm:px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs sm:text-sm shadow-lg shadow-blue-500/20 flex items-center gap-2 transition-colors cursor-pointer"
                            >
                                <Printer size={16} />
                                Imprimer / PDF (2 feuilles)
                            </button>
                        )}

                        {activeTab === 'AUDIT' && onRunAudit && (
                            <button
                                onClick={() => onRunAudit()}
                                disabled={loading}
                                className="px-4 sm:px-6 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white font-medium text-xs sm:text-sm shadow-lg shadow-purple-500/20 flex items-center gap-2 transition-colors cursor-pointer"
                            >
                                {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                {report ? "Relancer l'Audit IA" : "Lancer l'Audit IA"}
                            </button>
                        )}

                        {activeTab === 'CLOSING' && (
                            <button
                                onClick={handleConfirmCloseFiscalYear}
                                disabled={isClosing || !nextComptaName.trim()}
                                className="px-4 sm:px-6 py-2 rounded-lg bg-gradient-to-r from-orange-500 to-rose-600 hover:from-orange-600 hover:to-rose-700 disabled:opacity-50 text-white font-bold text-xs sm:text-sm shadow-lg shadow-orange-500/20 flex items-center gap-2 transition-all cursor-pointer"
                            >
                                {isClosing ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
                                Clôturer & Créer « {nextComptaName || 'Nouvel Exercice'} »
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
