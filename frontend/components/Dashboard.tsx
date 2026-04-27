import React from 'react';
import { Account, Transaction, AccountType, TransactionStatus } from '../../types';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Edit2, ChevronRight, ChevronDown, Layers, List } from 'lucide-react';

interface DashboardProps {
  transactions: Transaction[];
  accounts: Account[];
  onUpdateAccount: (account: Account) => Promise<void> | void;
  onNavigate: (tab: string) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ transactions, accounts, onUpdateAccount, onNavigate }) => {
  // --- CALCULATIONS ---
  
  // 1. Approved Totals
  const approvedTxns = transactions.filter(t => t.status === TransactionStatus.APPROVED);
  const nonApprovedTxns = transactions.filter(t => t.status !== TransactionStatus.APPROVED && t.status !== TransactionStatus.ARCHIVED);

  const totalIncome = approvedTxns.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = approvedTxns.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0);
  const netResult = totalIncome + totalExpense;

  // 2. Non-validated Totals
  const pendingDebit = Math.abs(nonApprovedTxns.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
  const pendingCredit = nonApprovedTxns.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);

  const incomeChartData = accounts
    .filter(a => !a.parentId) // Tous les parents
    .map(acc => {
      const childIds = (parentId: string): string[] => {
        const children = accounts.filter(a => a.parentId === parentId);
        return [...children.map(c => c.id), ...children.flatMap(c => childIds(c.id))];
      };
      const ids = [acc.id, ...childIds(acc.id)];
      // Somme des transactions POSITIVES (Produits) pour ce parent et ses enfants
      const val = approvedTxns.filter(t => t.accountId && ids.includes(t.accountId) && t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
      return { name: acc.label, value: val };
    })
    .filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value);

  const expenseChartData = accounts
    .filter(a => !a.parentId) // Tous les parents
    .map(acc => {
      const childIds = (parentId: string): string[] => {
        const children = accounts.filter(a => a.parentId === parentId);
        return [...children.map(c => c.id), ...children.flatMap(c => childIds(c.id))];
      };
      const ids = [acc.id, ...childIds(acc.id)];
      // Somme des transactions NÉGATIVES (Charges) pour ce parent et ses enfants
      const val = Math.abs(approvedTxns.filter(t => t.accountId && ids.includes(t.accountId) && t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
      return { name: acc.label, value: val };
    })
    .filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value);

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];
  
  // 4. State for Balance Editing Modal
  const [editingAccount, setEditingAccount] = React.useState<Account | null>(null);
  const [tempBalance, setTempBalance] = React.useState<number>(0);

  // 5. State for Hierarchical View
  const [isGrouped, setIsGrouped] = React.useState<boolean>(true);
  const [expandedAccounts, setExpandedAccounts] = React.useState<Set<string>>(new Set());

  const toggleExpand = (accId: string) => {
    const next = new Set(expandedAccounts);
    if (next.has(accId)) next.delete(accId);
    else next.add(accId);
    setExpandedAccounts(next);
  };

  const expandAll = () => {
    const allParentIds = accounts.filter(a => accounts.some(child => child.parentId === a.id)).map(a => a.id);
    setExpandedAccounts(new Set(allParentIds));
  };

  const collapseAll = () => setExpandedAccounts(new Set());

  // --- HELPERS ---

  const formatAmount = (val: number) => {
    if (val === 0) return '—';
    return val.toLocaleString('fr-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Hierarchical rendering logic
  const renderAccountRow = (acc: Account, depth: number = 0) => {
    const getAllChildIds = (parentId: string): string[] => {
      const children = accounts.filter(a => a.parentId === parentId);
      return [...children.map(c => c.id), ...children.flatMap(c => getAllChildIds(c.id))];
    };
    
    const children = accounts.filter(a => a.parentId === acc.id);
    const hasChildren = children.length > 0;
    const isExpanded = expandedAccounts.has(acc.id);

    // Calculation logic
    const childIds = getAllChildIds(acc.id);
    // If grouped, parent shows SUM of branch. If flat, shows only its own txns.
    const branchTxns = approvedTxns.filter(t => t.accountId === acc.id || (isGrouped && t.accountId && childIds.includes(t.accountId)));
    
    const initial = acc.initialBalance || 0;
    const debit = Math.abs(branchTxns.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
    const credit = branchTxns.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
    const balance = credit - debit;
    const total = initial + balance;

    const hasActivity = debit !== 0 || credit !== 0 || initial !== 0;
    const hasActiveChildren = children.some(c => {
      const cChildIds = getAllChildIds(c.id);
      const cTxns = approvedTxns.filter(t => t.accountId === c.id || (t.accountId && cChildIds.includes(t.accountId)));
      return cTxns.length > 0 || (c.initialBalance || 0) !== 0;
    });

    if (!hasActivity && !hasActiveChildren) return null;

    return (
      <React.Fragment key={acc.id}>
        <tr className={`hover:bg-slate-800/50 transition-colors ${depth === 0 ? 'bg-slate-900/20' : ''} ${hasChildren && isGrouped ? 'cursor-pointer' : ''}`}
            onClick={() => hasChildren && isGrouped && toggleExpand(acc.id)}>
          <td className="px-6 py-3" style={{ paddingLeft: `${1.5 + (isGrouped ? depth * 1.5 : 0)}rem` }}>
            <div className={`flex items-center gap-2 ${depth === 0 ? 'font-bold text-slate-100' : 'text-slate-300'}`}>
              {isGrouped && hasChildren && (
                <span className="text-slate-500">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              )}
              {!hasChildren && isGrouped && <span className="w-[14px]"></span>}
              <span className="text-[10px] font-mono text-slate-500 opacity-50">{acc.code}</span>
              {acc.label}
            </div>
          </td>
          <td className="px-6 py-3 text-right text-slate-500 font-mono text-xs italic">
            {(acc.type === AccountType.ASSET || acc.type === AccountType.LIABILITY) && (depth === 0 || !isGrouped) ? (
               <div onClick={(e) => e.stopPropagation()}>
                 <input 
                   type="number" 
                   step="0.01" 
                   defaultValue={initial} 
                   onBlur={(e) => {
                     const val = parseFloat(e.target.value);
                     if (!isNaN(val) && val !== initial) onUpdateAccount({ ...acc, initialBalance: val });
                   }}
                   className="bg-transparent border-b border-slate-800 hover:border-slate-600 focus:border-blue-500 text-right w-24 focus:outline-none transition-colors"
                 />
               </div>
            ) : ''}
          </td>
          <td className="px-6 py-3 text-right text-rose-400 font-mono">
            {formatAmount(debit)}
          </td>
          <td className="px-6 py-3 text-right text-emerald-400 font-mono">
            {formatAmount(credit)}
          </td>
          <td className={`px-6 py-3 text-right font-bold font-mono ${balance >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
            {formatAmount(balance)}
          </td>
          <td className={`px-6 py-3 text-right font-bold font-mono ${total >= 0 ? 'text-emerald-400' : 'text-rose-400'} bg-slate-950/30`}>
            {formatAmount(total)}
          </td>
        </tr>
        {isGrouped && isExpanded && children.sort((a, b) => a.code.localeCompare(b.code)).map(child => renderAccountRow(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 text-slate-200">
      <header className="flex justify-between items-end mb-8">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-3xl font-bold text-white">Vue d'ensemble financière</h2>
            <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 text-[10px] font-bold rounded border border-blue-500/30">v2.1</span>
          </div>
          <p className="text-slate-400">Analyse en temps réel de la santé de votre association.</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Exercice en cours</div>
          <div className="text-slate-200 font-mono">{new Date().getFullYear()}</div>
        </div>
      </header>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Verification Card (Calculated Balance at Last Transaction) */}
        <div className="bg-slate-900 p-4 rounded-xl border border-amber-500/30 shadow-lg bg-gradient-to-br from-slate-900 to-amber-900/5">
          <h3 className="text-[10px] font-bold text-amber-500 uppercase tracking-wider">Solde au {
            transactions.length > 0 
              ? [...transactions].sort((a,b) => b.date.split('.').reverse().join('-').localeCompare(a.date.split('.').reverse().join('-')))[0].date
              : '—'
          }</h3>
          <p className="text-xl font-black text-white mt-1">
            CHF {formatAmount(
              (accounts.find(a => a.type === AccountType.ASSET)?.initialBalance || 0) + 
              transactions.reduce((sum, t) => sum + t.amount, 0)
            )}
          </p>
          <p className="text-[9px] text-slate-500 mt-1 italic">Vérification avec relevé papier</p>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-lg border-l-4 border-l-blue-500">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Solde à l'ouverture</h3>
          {accounts.filter(a => a.type === AccountType.ASSET).slice(0, 1).map(acc => (
            <div key={acc.id} className="mt-1 flex items-baseline group cursor-pointer" onClick={() => {
                setEditingAccount(acc);
                setTempBalance(acc.initialBalance || 0);
            }}>
              <span className="text-slate-500 text-xs mr-1">CHF</span>
              <span className="text-xl font-black text-white group-hover:text-blue-400 transition-colors">
                {formatAmount(acc.initialBalance || 0)}
              </span>
              <Edit2 size={12} className="ml-2 text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          ))}
          {accounts.filter(a => a.type === AccountType.ASSET).length === 0 && (
            <div 
              className="mt-2 p-2 border border-dashed border-slate-700 rounded-lg hover:border-blue-500 hover:bg-blue-500/5 cursor-pointer transition-all"
              onClick={() => {
                const newAcc: Account = {
                  id: 'acc_' + Date.now(),
                  code: '1020',
                  label: 'Compte Bancaire',
                  description: 'Compte de trésorerie principal',
                  type: AccountType.ASSET,
                  isMembership: false,
                  initialBalance: 0
                };
                setEditingAccount(newAcc);
                setTempBalance(0);
              }}
            >
              <p className="text-[10px] text-slate-500 italic">Aucun compte ACTIF défini.</p>
              <p className="text-[9px] text-blue-400 font-bold mt-1">Cliquez pour configurer le solde initial</p>
            </div>
          )}
        </div>

        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-lg">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Recettes (Validées)</h3>
          <p className="text-xl font-black text-emerald-400 mt-1">CHF {formatAmount(totalIncome)}</p>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-lg">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Dépenses (Validées)</h3>
          <p className="text-xl font-black text-rose-400 mt-1">CHF {formatAmount(Math.abs(totalExpense))}</p>
        </div>

        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 shadow-lg relative overflow-hidden bg-gradient-to-br from-slate-900 to-blue-900/10">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Trésorerie Totale</h3>
          <p className={`text-xl font-black mt-1 ${(accounts.find(a => a.type === AccountType.ASSET)?.initialBalance || 0) + netResult >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
            CHF {formatAmount((accounts.find(a => a.type === AccountType.ASSET)?.initialBalance || 0) + netResult)}
          </p>
          <div className={`absolute bottom-0 left-0 h-1 w-full ${(accounts.find(a => a.type === AccountType.ASSET)?.initialBalance || 0) + netResult >= 0 ? 'bg-blue-500' : 'bg-orange-500'} opacity-30`}></div>
        </div>
      </div>

      {/* Main Hierarchical Table */}
      <div className="bg-slate-900 rounded-2xl shadow-2xl border border-slate-800 overflow-hidden">
        <div className="px-6 py-4 bg-slate-950/50 border-b border-slate-800 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <h3 className="font-bold text-slate-100">Détail des Comptes</h3>
            <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-800">
              <button 
                onClick={() => setIsGrouped(true)}
                className={`flex items-center gap-2 px-3 py-1 rounded-md text-xs font-bold transition-all ${isGrouped ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <Layers size={14} /> Hiérarchique
              </button>
              <button 
                onClick={() => setIsGrouped(false)}
                className={`flex items-center gap-2 px-3 py-1 rounded-md text-xs font-bold transition-all ${!isGrouped ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                <List size={14} /> Liste plate
              </button>
            </div>
            {isGrouped && (
              <div className="flex gap-2">
                <button onClick={expandAll} className="text-[10px] text-blue-400 hover:text-blue-300 font-bold uppercase">Tout déployer</button>
                <span className="text-slate-700">|</span>
                <button onClick={collapseAll} className="text-[10px] text-slate-500 hover:text-slate-400 font-bold uppercase">Tout réduire</button>
              </div>
            )}
          </div>
          <div className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-[10px] text-emerald-500 font-bold uppercase tracking-tighter">
            Données Approuvées
          </div>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead className="bg-slate-950 text-slate-500 text-[10px] uppercase font-bold tracking-widest border-b border-slate-800">
              <tr>
                <th className="px-6 py-4">Structure</th>
                <th className="px-6 py-4 text-right">Solde Initial</th>
                <th className="px-6 py-4 text-right">Débit</th>
                <th className="px-6 py-4 text-right">Crédit</th>
                <th className="px-6 py-4 text-right">Période</th>
                <th className="px-6 py-4 text-right text-slate-300">Cumulé</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              <tr className="bg-slate-950/30"><td colSpan={6} className="px-6 py-2 text-[10px] font-black text-emerald-500/50 uppercase tracking-tighter">Produits</td></tr>
              {accounts.filter(a => (!isGrouped || !a.parentId) && a.type === AccountType.INCOME).sort((a, b) => a.code.localeCompare(b.code)).map(acc => renderAccountRow(acc))}

              <tr className="bg-slate-950/30 border-t border-slate-800"><td colSpan={6} className="px-6 py-2 text-[10px] font-black text-rose-500/50 uppercase tracking-tighter">Charges</td></tr>
              {accounts.filter(a => (!isGrouped || !a.parentId) && a.type === AccountType.EXPENSE).sort((a, b) => a.code.localeCompare(b.code)).map(acc => renderAccountRow(acc))}

              {accounts.some(a => a.type !== AccountType.INCOME && a.type !== AccountType.EXPENSE) && (
                 <>
                   <tr className="bg-slate-950/30 border-t border-slate-800"><td colSpan={6} className="px-6 py-2 text-[10px] font-black text-blue-500/50 uppercase tracking-tighter">Bilan</td></tr>
                   {accounts.filter(a => (!isGrouped || !a.parentId) && a.type !== AccountType.INCOME && a.type !== AccountType.EXPENSE).sort((a, b) => a.code.localeCompare(b.code)).map(acc => renderAccountRow(acc))}
                 </>
              )}

              <tr className="bg-amber-500/5 border-t-2 border-slate-700">
                <td className="px-6 py-4 font-bold text-amber-500 flex items-center gap-2">
                  <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></div>
                  Flux non validés
                </td>
                <td className="px-6 py-4 text-right text-slate-600 font-mono italic">—</td>
                <td className="px-6 py-4 text-right text-amber-500/70 font-mono font-bold">{formatAmount(pendingDebit)}</td>
                <td className="px-6 py-4 text-right text-amber-500/70 font-mono font-bold">{formatAmount(pendingCredit)}</td>
                <td className="px-6 py-4 text-right font-black font-mono text-amber-500">{formatAmount(pendingCredit - pendingDebit)}</td>
                <td className="px-6 py-4 text-right text-slate-600 font-mono italic bg-slate-950/30">—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl h-[450px]">
          <h3 className="text-sm font-bold text-rose-400 uppercase tracking-widest mb-6 border-b border-rose-900/30 pb-2">Charges par Catégorie (Niveau 1)</h3>
          {expenseChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={expenseChartData} margin={{ top: 20, right: 30, left: 40, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis 
                  dataKey="name" 
                  stroke="#64748b" 
                  fontSize={10} 
                  angle={-45} 
                  textAnchor="end" 
                  interval={0}
                  height={60}
                />
                <YAxis 
                  stroke="#64748b" 
                  fontSize={10} 
                  label={{ value: 'CHF', angle: -90, position: 'insideLeft', offset: -10, fill: '#64748b', fontSize: 12, fontWeight: 'bold' }} 
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px', border: '1px solid #334155' }}
                  itemStyle={{ color: '#f1f5f9' }}
                />
                <Bar dataKey="value" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-slate-600 italic">Aucune dépense enregistrée</div>}
        </div>

        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl h-[450px]">
          <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-widest mb-6 border-b border-emerald-900/30 pb-2">Produits par Catégorie (Niveau 1)</h3>
          {incomeChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={incomeChartData} margin={{ top: 20, right: 30, left: 40, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis 
                  dataKey="name" 
                  stroke="#64748b" 
                  fontSize={10} 
                  angle={-45} 
                  textAnchor="end" 
                  interval={0}
                  height={60}
                />
                <YAxis 
                  stroke="#64748b" 
                  fontSize={10} 
                  label={{ value: 'CHF', angle: -90, position: 'insideLeft', offset: -10, fill: '#64748b', fontSize: 12, fontWeight: 'bold' }} 
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px', border: '1px solid #334155' }}
                  itemStyle={{ color: '#f1f5f9' }}
                />
                <Bar dataKey="value" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-slate-600 italic">Aucun revenu enregistré</div>}
        </div>
      </div>

      {/* Bank Reconciliation */}
      <div className="bg-slate-900 rounded-xl shadow-lg border border-slate-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/50">
          <h3 className="text-lg font-bold text-white">Réconciliation Bancaire</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-500 text-[10px] uppercase font-bold tracking-widest">
              <tr>
                <th className="px-6 py-4">Compte Financier</th>
                <th className="px-6 py-4 text-right">Solde Initial</th>
                <th className="px-6 py-4 text-right">Mouvements</th>
                <th className="px-6 py-4 text-right text-emerald-400">Calculé</th>
                <th className="px-6 py-4 text-right text-blue-400">Relevé</th>
                <th className="px-6 py-4 text-right">Écart</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {accounts.filter(a => a.type === AccountType.ASSET || transactions.some(t => t.accountId === a.id && a.type === AccountType.ASSET)).map(acc => {
                const accTxns = transactions.filter(t => t.accountId === acc.id);
                const movements = accTxns.reduce((sum, t) => sum + t.amount, 0);
                const initial = acc.initialBalance || 0;
                const calculatedBalance = initial + movements;
                const lastTxn = [...accTxns].sort((a, b) => b.date.split('.').reverse().join('-').localeCompare(a.date.split('.').reverse().join('-'))).find(t => t.runningBalance !== undefined);
                const lastStatementValue = lastTxn?.runningBalance;
                const gap = lastStatementValue !== undefined ? calculatedBalance - lastStatementValue : null;

                return (
                  <tr key={acc.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-6 py-4"><div className="font-bold text-slate-100">{acc.label}</div><div className="text-[10px] text-slate-500 font-mono uppercase">{acc.code}</div></td>
                    <td className="px-6 py-4 text-right">
                      <input type="number" step="0.01" defaultValue={initial} onBlur={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val) && val !== initial) onUpdateAccount({ ...acc, initialBalance: val });
                        }}
                        className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-right text-emerald-500 font-mono text-xs w-24 focus:border-emerald-500 focus:outline-none"
                      />
                    </td>
                    <td className="px-6 py-4 text-right text-slate-400 font-mono text-xs">{movements >= 0 ? '+' : ''}{formatAmount(movements)}</td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400 font-mono">{formatAmount(calculatedBalance)}</td>
                    <td className="px-6 py-4 text-right font-bold text-blue-400 font-mono">
                      {lastStatementValue !== undefined ? formatAmount(lastStatementValue) : '—'}
                      {lastTxn && <div className="text-[9px] font-normal text-slate-500 italic">au {lastTxn.date}</div>}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {gap !== null ? (
                        <span className={`font-mono text-[10px] font-bold px-2 py-1 rounded-full border ${Math.abs(gap) < 0.01 ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'}`}>
                          {Math.abs(gap) < 0.01 ? 'COHÉRENT' : `${gap > 0 ? '+' : ''}${gap.toFixed(2)}`}
                        </span>
                      ) : <span className="text-slate-600 text-[10px] italic">NON DISPONIBLE</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* BALANCE EDIT MODAL */}
      {editingAccount && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-blue-500/30 rounded-2xl p-8 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in duration-200">
            <h3 className="text-xl font-bold text-white mb-2">Modifier le Solde Initial</h3>
            <p className="text-slate-400 text-sm mb-6">Compte : {editingAccount.label} ({editingAccount.code})</p>
            
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 mb-6">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Nouveau Solde (CHF)</label>
                <input 
                    type="number"
                    step="0.01"
                    autoFocus
                    value={tempBalance}
                    onChange={(e) => setTempBalance(parseFloat(e.target.value) || 0)}
                    className="w-full bg-transparent text-2xl font-black text-emerald-400 focus:outline-none"
                />
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setEditingAccount(null)}
                className="px-6 py-2 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors text-sm font-medium"
              >
                Annuler
              </button>
              <button
                onClick={async () => {
                  await onUpdateAccount({ ...editingAccount, initialBalance: tempBalance });
                  setEditingAccount(null);
                }}
                className="px-6 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-500 font-bold shadow-lg shadow-blue-900/40 transition-all text-sm"
              >
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};