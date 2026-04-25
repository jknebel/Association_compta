import React from 'react';
import { Account, Transaction, AccountType, TransactionStatus } from '../../types';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';

interface DashboardProps {
  transactions: Transaction[];
  accounts: Account[];
  onUpdateAccount: (account: Account) => Promise<void> | void;
}

export const Dashboard: React.FC<DashboardProps> = ({ transactions, accounts, onUpdateAccount }) => {
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

  // 3. Chart Data (Main accounts only)
  const getBranchTotal = (accId: string) => {
    const getAllChildIds = (parentId: string): string[] => {
        const children = accounts.filter(a => a.parentId === parentId);
        return [...children.map(c => c.id), ...children.flatMap(c => getAllChildIds(c.id))];
    };
    const childIds = getAllChildIds(accId);
    const branchTxns = approvedTxns.filter(t => t.accountId === accId || (t.accountId && childIds.includes(t.accountId)));
    return branchTxns.reduce((sum, t) => sum + t.amount, 0);
  };

  const incomeChartData = accounts
    .filter(a => !a.parentId && a.type === AccountType.INCOME)
    .map(acc => ({ name: acc.label, value: getBranchTotal(acc.id) }))
    .filter(d => d.value > 0);

  const expenseChartData = accounts
    .filter(a => !a.parentId && a.type === AccountType.EXPENSE)
    .map(acc => ({ name: acc.label, value: Math.abs(getBranchTotal(acc.id)) }))
    .filter(d => d.value > 0);

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

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
    
    const childIds = getAllChildIds(acc.id);
    const branchTxns = approvedTxns.filter(t => t.accountId === acc.id || (t.accountId && childIds.includes(t.accountId)));
    
    const initial = acc.initialBalance || 0;
    const debit = Math.abs(branchTxns.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
    const credit = branchTxns.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
    const balance = credit - debit;
    const total = initial + balance;

    const children = accounts.filter(a => a.parentId === acc.id);
    const hasActivity = debit !== 0 || credit !== 0 || initial !== 0;
    const hasActiveChildren = children.some(c => {
      const cChildIds = getAllChildIds(c.id);
      const cTxns = approvedTxns.filter(t => t.accountId === c.id || (t.accountId && cChildIds.includes(t.accountId)));
      return cTxns.length > 0 || (c.initialBalance || 0) !== 0;
    });

    if (!hasActivity && !hasActiveChildren) return null;

    return (
      <React.Fragment key={acc.id}>
        <tr className={`hover:bg-slate-800/50 transition-colors ${depth === 0 ? 'bg-slate-900/20' : ''}`}>
          <td className="px-6 py-3" style={{ paddingLeft: `${1.5 + depth * 1.5}rem` }}>
            <div className={`flex items-center gap-2 ${depth === 0 ? 'font-bold text-slate-100' : 'text-slate-300'}`}>
              <span className="text-[10px] font-mono text-slate-500 opacity-50">{acc.code}</span>
              {acc.label}
            </div>
          </td>
          <td className="px-6 py-3 text-right text-slate-500 font-mono text-xs italic">
            {depth === 0 ? (
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
            {depth === 0 ? formatAmount(total) : ''}
          </td>
        </tr>
        {children.sort((a, b) => a.code.localeCompare(b.code)).map(child => renderAccountRow(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 text-slate-200">
      <header className="flex justify-between items-end mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white">Vue d'ensemble financière</h2>
          <p className="text-slate-400">Analyse en temps réel de la santé de votre association.</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Exercice en cours</div>
          <div className="text-slate-200 font-mono">{new Date().getFullYear()}</div>
        </div>
      </header>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 shadow-lg">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Recettes (Validées)</h3>
          <p className="text-3xl font-black text-emerald-400 mt-2">CHF {formatAmount(totalIncome)}</p>
        </div>
        <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 shadow-lg">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Dépenses (Validées)</h3>
          <p className="text-3xl font-black text-rose-400 mt-2">CHF {formatAmount(Math.abs(totalExpense))}</p>
        </div>
        <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 shadow-lg relative overflow-hidden">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Résultat Net</h3>
          <p className={`text-3xl font-black mt-2 ${netResult >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
            CHF {formatAmount(netResult)}
          </p>
          <div className={`absolute bottom-0 left-0 h-1 w-full ${netResult >= 0 ? 'bg-blue-500' : 'bg-orange-500'} opacity-30`}></div>
        </div>
      </div>

      {/* Main Hierarchical Table */}
      <div className="bg-slate-900 rounded-2xl shadow-2xl border border-slate-800 overflow-hidden">
        <div className="px-6 py-4 bg-slate-950/50 border-b border-slate-800 flex justify-between items-center">
          <h3 className="font-bold text-slate-100">Détail des Comptes</h3>
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
              {accounts.filter(a => !a.parentId && a.type === AccountType.INCOME).sort((a, b) => a.code.localeCompare(b.code)).map(acc => renderAccountRow(acc))}

              <tr className="bg-slate-950/30 border-t border-slate-800"><td colSpan={6} className="px-6 py-2 text-[10px] font-black text-rose-500/50 uppercase tracking-tighter">Charges</td></tr>
              {accounts.filter(a => !a.parentId && a.type === AccountType.EXPENSE).sort((a, b) => a.code.localeCompare(b.code)).map(acc => renderAccountRow(acc))}

              {accounts.some(a => !a.parentId && a.type !== AccountType.INCOME && a.type !== AccountType.EXPENSE) && (
                 <>
                   <tr className="bg-slate-950/30 border-t border-slate-800"><td colSpan={6} className="px-6 py-2 text-[10px] font-black text-blue-500/50 uppercase tracking-tighter">Bilan</td></tr>
                   {accounts.filter(a => !a.parentId && a.type !== AccountType.INCOME && a.type !== AccountType.EXPENSE).sort((a, b) => a.code.localeCompare(b.code)).map(acc => renderAccountRow(acc))}
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
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl h-[400px]">
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">Dépenses par Catégorie</h3>
          {expenseChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={expenseChartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {expenseChartData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px', border: '1px solid #334155' }}
                  itemStyle={{ color: '#f1f5f9' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-slate-600 italic">Aucune donnée</div>}
        </div>

        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl h-[400px]">
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">Sources de Revenus</h3>
          {incomeChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={incomeChartData}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 40, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                <XAxis type="number" stroke="#64748b" fontSize={10} />
                <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={10} width={100} />
                <Tooltip 
                   contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px', border: '1px solid #334155' }}
                   itemStyle={{ color: '#f1f5f9' }}
                />
                <Bar dataKey="value" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-full flex items-center justify-center text-slate-600 italic">Aucune donnée</div>}
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
    </div>
  );
};