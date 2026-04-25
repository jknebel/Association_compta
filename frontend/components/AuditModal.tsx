import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, Printer, CheckCircle, AlertTriangle, FileText, Bot, Receipt, Archive, Loader2 } from 'lucide-react';
import { Transaction, Account, AccountType } from '../../types';

interface AuditModalProps {
    isOpen: boolean;
    onClose: () => void;
    report: string;
    loading: boolean;
    transactions: Transaction[];
    accounts: Account[];
    onCloseFiscalYear: (finalAccounts: Account[], transactionsToArchive: Transaction[]) => Promise<void>;
}

export const AuditModal: React.FC<AuditModalProps> = ({ isOpen, onClose, report, loading, transactions, accounts, onCloseFiscalYear }) => {
    const [activeTab, setActiveTab] = useState<'REPORT' | 'AUDIT' | 'CLOSING'>('REPORT');
    const [isClosing, setIsClosing] = useState(false);

    if (!isOpen) return null;

    const handlePrint = () => {
        window.print();
    };

    // --- LOGIQUE DE GÉNÉRATION DU RAPPORT DE CLÔTURE ---

    // 1. Calcul du Bilan / Compte de Résultat Simplifié
    const charges = transactions
        .filter(t => t.amount < 0)
        .reduce((acc, t) => {
            const account = accounts.find(a => a.id === t.accountId);
            // On ne prend que les charges (Classe 6) pour un vrai bilan, mais ici on simplifie
            // Si on veut être strict, on filtre par type de compte.
            // On va grouper par Code Compte.
            const code = account ? account.code : 'Inconnu';
            const label = account ? account.label : 'Non catégorisé';

            if (!acc[code]) acc[code] = { label, amount: 0 };
            acc[code].amount += Math.abs(t.amount); // On affiche en positif dans le tableau des charges
            return acc;
        }, {} as Record<string, { label: string, amount: number }>);

    const produits = transactions
        .filter(t => t.amount > 0)
        .reduce((acc, t) => {
            const account = accounts.find(a => a.id === t.accountId);
            const code = account ? account.code : 'Inconnu';
            const label = account ? account.label : 'Non catégorisé';

            if (!acc[code]) acc[code] = { label, amount: 0 };
            acc[code].amount += t.amount;
            return acc;
        }, {} as Record<string, { label: string, amount: number }>);

    const totalCharges = Object.values(charges).reduce((sum, c) => sum + c.amount, 0);
    const totalProduits = Object.values(produits).reduce((sum, p) => sum + p.amount, 0);
    const resultat = totalProduits - totalCharges;

    // 2. Journal pour l'impression (Trié par date)
    const sortedTransactions = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200 overflow-y-auto print:p-0 print:bg-white print:static print:block">
            <div className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-5xl md:h-[90vh] flex flex-col overflow-hidden print:shadow-none print:h-auto print:w-full print:max-w-none print:rounded-none">

                {/* Header (Écran uniquement) */}
                <div className="p-6 bg-slate-50 border-b border-slate-200 flex justify-between items-center print:hidden">
                    <div>
                        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                            <CheckCircle className="text-emerald-600" />
                            Clôture & Audit
                        </h2>
                        <p className="text-slate-500 text-sm mt-1">Générez votre rapport officiel ou consultez l'avis de l'IA.</p>
                    </div>

                    <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button
                            onClick={() => setActiveTab('REPORT')}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${activeTab === 'REPORT' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            <FileText size={16} />
                            Rapport Comptable
                        </button>
                        <button
                            onClick={() => setActiveTab('AUDIT')}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${activeTab === 'AUDIT' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            <Bot size={16} />
                            Audit IA
                        </button>
                        <button
                            onClick={() => setActiveTab('CLOSING')}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${activeTab === 'CLOSING' ? 'bg-white text-orange-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            <Archive size={16} />
                            Clôture & Archivage
                        </button>
                    </div>

                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                    >
                        <X size={24} className="text-slate-500" />
                    </button>
                </div>

                {/* Content Container */}
                <div className="flex-1 overflow-y-auto bg-white print:overflow-visible">

                    {/* TAB: RAPPORT COMPTABLE (Ce qui sera imprimé) */}
                    <div className={`${activeTab === 'REPORT' ? 'block' : 'hidden'} print:block`}>
                        <div className="p-8 max-w-4xl mx-auto print:p-0 print:max-w-none">

                            {/* PAGE 1: BILAN / COMPTE DE RÉSULTAT */}
                            <div className="print-section mb-12">
                                <header className="text-center mb-12 border-b-2 border-slate-900 pb-6">
                                    <h1 className="text-3xl font-bold uppercase tracking-wide mb-2">Rapport de Clôture</h1>
                                    <p className="text-slate-500 text-lg">Exercice Comptable {new Date().getFullYear()}</p>
                                    <p className="text-sm text-slate-400 mt-2">Généré le {new Date().toLocaleDateString()}</p>
                                </header>

                                <div className="grid grid-cols-2 gap-12 print:grid-cols-2">
                                    {/* CHARGES */}
                                    <div>
                                        <h3 className="text-xl font-bold border-b border-rose-500 text-rose-700 mb-4 pb-2">CHARGES (Dépenses)</h3>
                                        <table className="w-full text-sm">
                                            <tbody>
                                                {Object.entries(charges).sort().map(([code, data]) => (
                                                    <tr key={code} className="border-b border-slate-100">
                                                        <td className="py-2 text-slate-500 font-mono">{code}</td>
                                                        <td className="py-2 text-slate-700">{data.label}</td>
                                                        <td className="py-2 text-right font-medium">{data.amount.toFixed(2)}</td>
                                                    </tr>
                                                ))}
                                                <tr className="bg-rose-50 font-bold text-rose-900">
                                                    <td colSpan={2} className="py-3 px-2">TOTAL CHARGES</td>
                                                    <td className="py-3 text-right px-2">{totalCharges.toFixed(2)}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* PRODUITS */}
                                    <div>
                                        <h3 className="text-xl font-bold border-b border-emerald-500 text-emerald-700 mb-4 pb-2">PRODUITS (Recettes)</h3>
                                        <table className="w-full text-sm">
                                            <tbody>
                                                {Object.entries(produits).sort().map(([code, data]) => (
                                                    <tr key={code} className="border-b border-slate-100">
                                                        <td className="py-2 text-slate-500 font-mono">{code}</td>
                                                        <td className="py-2 text-slate-700">{data.label}</td>
                                                        <td className="py-2 text-right font-medium">{data.amount.toFixed(2)}</td>
                                                    </tr>
                                                ))}
                                                <tr className="bg-emerald-50 font-bold text-emerald-900">
                                                    <td colSpan={2} className="py-3 px-2">TOTAL PRODUITS</td>
                                                    <td className="py-3 text-right px-2">{totalProduits.toFixed(2)}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* RÉSULTAT */}
                                <div className={`mt-8 p-6 rounded-lg text-center border-2 ${resultat >= 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
                                    <h3 className="text-lg font-semibold uppercase mb-1">Résultat de l'exercice</h3>
                                    <div className="text-4xl font-bold">
                                        {resultat >= 0 ? '+' : ''}{resultat.toFixed(2)} CHF
                                    </div>
                                    <p className="mt-2 font-medium">{resultat >= 0 ? 'BÉNÉFICE' : 'PERTE'}</p>
                                </div>
                            </div>

                            <div className="print:break-after-page"></div>

                            {/* PAGE 2+: JOURNAL DES ÉCRITURES */}
                            <div className="print-section pt-8">
                                <h2 className="text-2xl font-bold mb-6 pb-2 border-b border-slate-300">Journal des Écritures</h2>
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-slate-100 text-slate-600 font-semibold uppercase text-xs">
                                        <tr>
                                            <th className="px-4 py-3">Date</th>
                                            <th className="px-4 py-3">Compte</th>
                                            <th className="px-4 py-3">Libellé</th>
                                            <th className="px-4 py-3 text-right">Débit</th>
                                            <th className="px-4 py-3 text-right">Crédit</th>
                                            <th className="px-4 py-3 text-center">Réf. PJ</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {sortedTransactions.map((t, idx) => {
                                            const account = accounts.find(a => a.id === t.accountId);
                                            const hasReceipt = !!t.receiptUrl;
                                            return (
                                                <tr key={t.id} className="hover:bg-slate-50">
                                                    <td className="px-4 py-3 whitespace-nowrap text-slate-500">{t.date}</td>
                                                    <td className="px-4 py-3 font-mono text-slate-700">{account?.code}</td>
                                                    <td className="px-4 py-3 text-slate-800 max-w-[300px] truncate">{t.description}</td>
                                                    <td className="px-4 py-3 text-right font-mono text-rose-600 bg-rose-50/30">
                                                        {t.amount < 0 ? Math.abs(t.amount).toFixed(2) : '-'}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-mono text-emerald-600 bg-emerald-50/30">
                                                        {t.amount > 0 ? t.amount.toFixed(2) : '-'}
                                                    </td>
                                                    <td className="px-4 py-3 text-center text-xs text-slate-400">
                                                        {hasReceipt ? (
                                                            <a href={`#receipt-${t.id}`} className="text-blue-600 hover:underline">PJ</a>
                                                        ) : '-'}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            <div className="print:break-after-page"></div>

                            {/* PAGE 3+: PIÈCES JUSTIFICATIVES */}
                            <div className="print-section pt-8">
                                <h2 className="text-2xl font-bold mb-6 pb-2 border-b border-slate-300">Annexes : Pièces Justificatives</h2>
                                <div className="space-y-12">
                                    {sortedTransactions.filter(t => t.receiptUrl).map((t) => (
                                        <div key={t.id} id={`receipt-${t.id}`} className="break-inside-avoid print:break-inside-avoid mb-12 border rounded-lg p-4 bg-slate-50 print:bg-white print:border-slate-200">
                                            <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-200">
                                                <div>
                                                    <h4 className="font-bold text-slate-800">{new Date(t.date).toLocaleDateString()} - {Math.abs(t.amount).toFixed(2)} CHF</h4>
                                                    <p className="text-sm text-slate-500">{t.description}</p>
                                                </div>
                                                <span className="bg-slate-200 text-slate-600 text-xs px-2 py-1 rounded">Réf: {t.id.slice(0, 8)}</span>
                                            </div>
                                            <div className="flex justify-center bg-white border border-slate-200 rounded p-2">
                                                {/* Note: Pour les PDFs, il faudrait idéalement un viewer, mais pour l'impression navigateur, une image/iframe suffit souvent. */}
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

                        </div>
                    </div>

                    {/* TAB: AUDIT IA (Lecture seule) */}
                    <div className={`${activeTab === 'AUDIT' ? 'block' : 'hidden'} print:hidden p-8`}>
                        {loading ? (
                            <div className="flex flex-col items-center justify-center h-64 gap-4">
                                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
                                <p className="text-slate-500 animate-pulse">L'expert IA analyse vos comptes...</p>
                            </div>
                        ) : (
                            <div className="prose prose-slate max-w-none">
                                <div className="mb-6 p-4 bg-purple-50 border border-purple-100 rounded-lg text-sm text-purple-800 flex items-start gap-3">
                                    <Bot size={20} className="shrink-0 mt-0.5" />
                                    <div>
                                        <p className="font-bold mb-1">Analyse de l'Assistant IA</p>
                                        <p>Ceci est une analyse automatique pour vous aider à détecter des anomalies. Elle ne figure pas sur le rapport officiel imprimé.</p>
                                    </div>
                                </div>
                                <ReactMarkdown>{report}</ReactMarkdown>
                            </div>
                        )}
                    </div>

                    {/* TAB: CLOSING CONTROL */}
                    <div className={`${activeTab === 'CLOSING' ? 'block' : 'hidden'} print:hidden p-8`}>
                        <div className="max-w-4xl mx-auto space-y-8">
                            <div className="bg-orange-50 border border-orange-200 p-4 rounded-lg flex gap-4 text-orange-800">
                                <AlertTriangle className="shrink-0" />
                                <div>
                                    <h4 className="font-bold">Contrôle de Fin d'Exercice</h4>
                                    <p className="text-sm">Vérifiez que les soldes calculés par le système correspondent aux soldes réels de vos comptes. La clôture archivera définitivement ces {transactions.length} écritures.</p>
                                </div>
                            </div>

                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-500 font-bold">
                                        <th className="py-3">Compte</th>
                                        <th className="py-3 text-right">Solde Actuel</th>
                                        <th className="py-3 text-right">Solde de Clôture Cible</th>
                                        <th className="py-3 text-right">Écart</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {accounts.filter(a => a.initialBalance !== 0 || transactions.some(t => t.accountId === a.id)).map(acc => {
                                        const movements = transactions.filter(t => t.accountId === acc.id).reduce((sum, t) => sum + t.amount, 0);
                                        const calculated = (acc.initialBalance || 0) + movements;
                                        const target = acc.closingBalance;
                                        const gap = target !== undefined ? calculated - target : null;

                                        return (
                                            <tr key={acc.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                                                <td className="py-4">
                                                    <div className="font-bold text-slate-800">{acc.label}</div>
                                                    <div className="text-xs text-slate-500 font-mono">{acc.code}</div>
                                                </td>
                                                <td className="py-4 text-right font-mono text-slate-700">{calculated.toLocaleString('fr-CH', { minimumFractionDigits: 2 })}</td>
                                                <td className="py-4 text-right font-mono text-slate-700">
                                                    {target !== undefined ? target.toLocaleString('fr-CH', { minimumFractionDigits: 2 }) : <span className="text-slate-400 italic">Non défini</span>}
                                                </td>
                                                <td className="py-4 text-right">
                                                    {gap !== null ? (
                                                        <span className={`font-mono text-sm font-bold px-2 py-1 rounded ${Math.abs(gap) < 0.01 ? 'text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                                                            {Math.abs(gap) < 0.01 ? '✓ OK' : `${gap > 0 ? '+' : ''}${gap.toFixed(2)}`}
                                                        </span>
                                                    ) : (
                                                        <span className="text-slate-400 text-xs italic">Manquant</span>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>

                            <div className="bg-slate-100 p-6 rounded-xl border border-slate-200">
                                <h4 className="font-bold text-slate-800 mb-4">Actions de Clôture</h4>
                                <div className="space-y-4">
                                    <div className="flex items-start gap-3 text-sm text-slate-600">
                                        <CheckCircle className="text-emerald-500 shrink-0 mt-0.5" size={16} />
                                        <span>Les {transactions.length} écritures seront marquées comme "Archivées" et n'apparaîtront plus dans le journal courant.</span>
                                    </div>
                                    <div className="flex items-start gap-3 text-sm text-slate-600">
                                        <CheckCircle className="text-emerald-500 shrink-0 mt-0.5" size={16} />
                                        <span>Le solde de clôture cible deviendra le nouveau solde initial pour l'exercice suivant.</span>
                                    </div>
                                    
                                    <div className="pt-6 border-t border-slate-200 flex flex-col items-center gap-4">
                                        <p className="text-xs text-slate-500 text-center max-w-md italic">
                                            Assurez-vous d'avoir imprimé ou sauvegardé votre rapport de clôture avant de valider. 
                                            Cette action est définitive pour l'organisation des données.
                                        </p>
                                        <button
                                            disabled={isClosing}
                                            onClick={async () => {
                                                if (!window.confirm("Êtes-vous sûr de vouloir clôturer l'exercice ?\n\n- Les transactions seront archivées.\n- Le solde initial sera mis à jour.")) return;
                                                
                                                setIsClosing(true);
                                                try {
                                                    // Prepare final accounts
                                                    const finalAccounts = accounts.map(acc => {
                                                        const movements = transactions.filter(t => t.accountId === acc.id).reduce((sum, t) => sum + t.amount, 0);
                                                        const calculated = (acc.initialBalance || 0) + movements;
                                                        return {
                                                            ...acc,
                                                            initialBalance: acc.closingBalance !== undefined ? acc.closingBalance : calculated,
                                                            closingBalance: undefined // Reset for next year
                                                        };
                                                    });
                                                    
                                                    await onCloseFiscalYear(finalAccounts, transactions);
                                                    alert("Clôture effectuée avec succès ! L'application va redémarrer sur le nouvel exercice.");
                                                    onClose();
                                                } catch (e) {
                                                    alert("Erreur lors de la clôture.");
                                                } finally {
                                                    setIsClosing(false);
                                                }
                                            }}
                                            className={`px-8 py-3 rounded-xl font-bold text-lg shadow-xl transition-all flex items-center gap-3 ${isClosing ? 'bg-slate-400 cursor-wait' : 'bg-gradient-to-r from-orange-500 to-rose-600 text-white hover:from-orange-600 hover:to-rose-700 shadow-orange-500/20 hover:scale-105'}`}
                                        >
                                            {isClosing ? <Loader2 className="animate-spin" /> : <Archive size={20} />}
                                            Clôturer & Archiver l'Année
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer (Actions) */}
                <div className="p-6 bg-slate-50 border-t border-slate-200 flex justify-between items-center print:hidden">
                    <div className="text-sm text-slate-400">
                        {transactions.length} écritures - {new Date().toLocaleDateString()}
                    </div>
                    <div className="flex gap-3">
                        <button
                            onClick={onClose}
                            className="px-6 py-2 rounded-lg text-slate-600 hover:bg-slate-200 font-medium transition-colors"
                        >
                            Fermer
                        </button>
                        <button
                            onClick={handlePrint}
                            className={`px-6 py-2 rounded-lg text-white font-medium shadow-lg flex items-center gap-2 transition-colors ${activeTab === 'REPORT' ? 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/20' : 'bg-slate-400 cursor-not-allowed'}`}
                            disabled={activeTab !== 'REPORT'}
                            title={activeTab !== 'REPORT' ? "Passez sur l'onglet 'Rapport Comptable' pour imprimer" : "Imprimer ou Enregistrer en PDF"}
                        >
                            <Printer size={18} />
                            Imprimer / PDF
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

