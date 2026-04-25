import React from 'react';
import { Account, Transaction, AccountType, TransactionStatus } from '../../types';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';

interface DashboardProps {
  transactions: Transaction[];
  accounts: Account[];
  onUpdateAccount: (account: Account) => Promise<void> | void;
}

export const Dashboard: React.FC<DashboardProps> = ({ transactions, accounts, onUpdateAccount }) => {
  const totalIncome = transactions
    .filter(t => t.amount > 0)
    .reduce((sum, t) => sum + t.amount, 0);

  const totalExpense = transactions
    .filter(t => t.amount < 0)
    .reduce((sum, t) => sum + t.amount, 0);

  const balance = totalIncome + totalExpense;

  // Prepare data for charts
  const incomeByAccount = accounts
    .filter(a => a.type === AccountType.INCOME)
    .map(acc => ({
      name: acc.label,
      value: transactions
        .filter(t => t.accountId === acc.id && t.amount > 0)
        .reduce((sum, t) => sum + t.amount, 0)
    }))
    .filter(d => d.value > 0);

  const expenseByAccount = accounts
    .filter(a => a.type === AccountType.EXPENSE)
    .map(acc => ({
      name: acc.label,
      value: Math.abs(transactions
        .filter(t => t.accountId === acc.id && t.amount < 0)
        .reduce((sum, t) => sum + t.amount, 0))
    }))
    .filter(d => d.value > 0);

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <header className="mb-8">
        <h2 className="text-3xl font-bold text-slate-100">Vue d'ensemble financière</h2>
        <p className="text-slate-400">Analyse en temps réel de la santé de votre association.</p>
      </header>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-800">
          <h3 className="text-sm font-medium text-slate-400 uppercase">Total Recettes</h3>
          <p className="text-3xl font-bold text-emerald-400 mt-2">CHF {totalIncome.toFixed(2)}</p>
        </div>
        <div className="bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-800">
          <h3 className="text-sm font-medium text-slate-400 uppercase">Total Dépenses</h3>
          <p className="text-3xl font-bold text-rose-400 mt-2">CHF {Math.abs(totalExpense).toFixed(2)}</p>
        </div>
        <div className="bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-800">
          <h3 className="text-sm font-medium text-slate-400 uppercase">Résultat Net</h3>
          <p className={`text-3xl font-bold mt-2 ${balance >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
            CHF {balance.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-800 h-96">
          <h3 className="text-lg font-bold text-slate-200 mb-4">Dépenses par Catégorie</h3>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={expenseByAccount}
                cx="50%"
                cy="50%"
                labelLine={false}
                outerRadius={80}
                fill="#8884d8"
                dataKey="value"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              >
                {expenseByAccount.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number) => `CHF ${value.toFixed(2)}`}
                contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f1f5f9' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-slate-900 p-6 rounded-xl shadow-sm border border-slate-800 h-96">
          <h3 className="text-lg font-bold text-slate-200 mb-4">Sources de Revenus</h3>
          {incomeByAccount.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={incomeByAccount}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  formatter={(value: number) => `CHF ${value.toFixed(2)}`}
                  contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f1f5f9' }}
                  cursor={{ fill: '#334155', opacity: 0.4 }}
                />
                <Bar dataKey="value" fill="#10B981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-500">
              Aucune recette enregistrée pour le moment.
            </div>
          )}
        </div>
      </div>

      {/* Detailed Account Performance (Approved Only) */}
      <div className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-950/50">
          <h3 className="text-lg font-bold text-slate-200">Situation des Comptes (Vérifié)</h3>
          <span className="text-xs text-emerald-500 font-medium px-2 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/20">
            Transactions Approuvées Uniquement
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3 font-semibold">Code / Compte</th>
                <th className="px-6 py-3 font-semibold text-right">Solde Initial</th>
                <th className="px-6 py-3 font-semibold text-right">Débit (Charges)</th>
                <th className="px-6 py-3 font-semibold text-right">Crédit (Produits)</th>
                <th className="px-6 py-3 font-semibold text-right">Solde Période</th>
                <th className="px-6 py-3 font-semibold text-right text-emerald-400">Total Cumulé</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {accounts.map(acc => {
                const accTxns = transactions.filter(t => t.accountId === acc.id && t.status === TransactionStatus.APPROVED);
                const initial = acc.initialBalance || 0;
                const debit = Math.abs(accTxns.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
                const credit = accTxns.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
                const balance = credit - debit;
                const total = initial + balance;

                if (debit === 0 && credit === 0 && initial === 0) return null; // Skip empty accounts for clarity

                return (
                  <tr key={acc.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium text-slate-200">{acc.label}</div>
                      <div className="text-xs text-slate-500 font-mono">{acc.code}</div>
                    </td>
                    <td className="px-6 py-4 text-right text-slate-500 font-mono italic">
                      {initial.toLocaleString('fr-CH', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 text-right text-rose-400 font-mono">
                      {debit > 0 ? debit.toLocaleString('fr-CH', { minimumFractionDigits: 2 }) : '—'}
                    </td>
                    <td className="px-6 py-4 text-right text-emerald-400 font-mono">
                      {credit > 0 ? credit.toLocaleString('fr-CH', { minimumFractionDigits: 2 }) : '—'}
                    </td>
                    <td className={`px-6 py-4 text-right font-bold font-mono ${balance >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
                      {balance.toLocaleString('fr-CH', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400 font-mono bg-emerald-500/5">
                      {total.toLocaleString('fr-CH', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pending Transactions Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 p-6">
          <h3 className="text-sm font-bold text-slate-400 uppercase mb-4 flex items-center gap-2">
            <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></span>
            En cours de validation
          </h3>
          <div className="space-y-4">
            {[TransactionStatus.REVIEW_NEEDED, TransactionStatus.PENDING_REVIEW, TransactionStatus.PENDING].map(status => {
              const txns = transactions.filter(t => t.status === status);
              const total = txns.reduce((sum, t) => sum + t.amount, 0);
              const count = txns.length;
              if (count === 0) return null;

              return (
                <div key={status} className="flex justify-between items-center p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <div>
                    <div className="text-xs text-slate-500 font-medium">
                      {status === TransactionStatus.REVIEW_NEEDED ? 'À VÉRIFIER' : status === TransactionStatus.PENDING_REVIEW ? 'EN ATTENTE DE REVUE' : 'EN ATTENTE'}
                    </div>
                    <div className="text-sm font-bold text-slate-200">{count} transaction{count > 1 ? 's' : ''}</div>
                  </div>
                  <div className={`text-sm font-mono font-bold ${total >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {total >= 0 ? '+' : ''}{total.toLocaleString('fr-CH', { minimumFractionDigits: 2 })}
                  </div>
                </div>
              );
            })}
            {transactions.filter(t => t.status !== TransactionStatus.APPROVED && t.status !== TransactionStatus.ARCHIVED).length === 0 && (
              <div className="text-center py-4 text-slate-600 italic text-sm">
                Aucune transaction en attente. Votre comptabilité est à jour !
              </div>
            )}
          </div>
        </div>

        <div className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 p-6 flex flex-col justify-center items-center text-center">
          <div className="text-xs text-slate-500 uppercase font-bold mb-2">Progression de la saisie</div>
          <div className="text-4xl font-black text-slate-100 mb-2">
            {Math.round((transactions.filter(t => t.status === TransactionStatus.APPROVED).length / (transactions.filter(t => t.status !== TransactionStatus.ARCHIVED).length || 1)) * 100)}%
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 mt-4 max-w-xs">
            <div 
              className="bg-blue-600 h-2 rounded-full transition-all duration-1000" 
              style={{ width: `${(transactions.filter(t => t.status === TransactionStatus.APPROVED).length / (transactions.filter(t => t.status !== TransactionStatus.ARCHIVED).length || 1)) * 100}%` }}
            ></div>
          </div>
          <p className="text-[10px] text-slate-500 mt-4">
            {transactions.filter(t => t.status === TransactionStatus.APPROVED).length} validées sur {transactions.filter(t => t.status !== TransactionStatus.ARCHIVED).length} actives
          </p>
        </div>
      </div>

      {/* Account Balances Section */}
      <div className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center">
          <h3 className="text-lg font-bold text-slate-200">Soldes des Comptes & Contrôle</h3>
          <span className="text-xs text-slate-500 italic">Vérification de la cohérence avec les relevés bancaires</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-6 py-3 font-semibold">Compte</th>
                <th className="px-6 py-3 font-semibold text-right">Solde Initial</th>
                <th className="px-6 py-3 font-semibold text-right">Mouvements</th>
                <th className="px-6 py-3 font-semibold text-right text-emerald-400">Solde Calculé</th>
                <th className="px-6 py-3 font-semibold text-right text-blue-400">Dernier Relevé</th>
                <th className="px-6 py-3 font-semibold text-right">Écart</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {accounts.filter(a => (a.initialBalance !== 0 || transactions.some(t => t.accountId === a.id))).map(acc => {
                const accTxns = transactions.filter(t => t.accountId === acc.id);
                const movements = accTxns.reduce((sum, t) => sum + t.amount, 0);
                const initial = acc.initialBalance || 0;
                const calculatedBalance = initial + movements;
                
                // Find last transaction with a runningBalance
                const lastTxn = [...accTxns]
                  .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                  .find(t => t.runningBalance !== undefined);
                
                const lastStatementValue = lastTxn?.runningBalance;
                const gap = lastStatementValue !== undefined ? calculatedBalance - lastStatementValue : null;

                return (
                  <tr key={acc.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium text-slate-200">{acc.label}</div>
                      <div className="text-xs text-slate-500 font-mono">{acc.code}</div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <input 
                        type="number" 
                        step="0.01"
                        defaultValue={initial}
                        onBlur={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val) && val !== initial) {
                            onUpdateAccount({ ...acc, initialBalance: val });
                          }
                        }}
                        className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-right text-emerald-500 font-mono text-xs w-24 focus:border-emerald-500 focus:outline-none transition-all"
                      />
                    </td>
                    <td className="px-6 py-4 text-right text-slate-400 font-mono">
                      {movements >= 0 ? '+' : ''}{movements.toLocaleString('fr-CH', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 text-right font-bold text-emerald-400 font-mono">
                      {calculatedBalance.toLocaleString('fr-CH', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 text-right font-bold text-blue-400 font-mono">
                      {lastStatementValue !== undefined 
                        ? lastStatementValue.toLocaleString('fr-CH', { minimumFractionDigits: 2 })
                        : '—'
                      }
                      {lastTxn && <div className="text-[10px] font-normal text-slate-500 italic">au {lastTxn.date}</div>}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {gap !== null ? (
                        <span className={`font-mono text-xs px-2 py-1 rounded ${Math.abs(gap) < 0.01 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                          {Math.abs(gap) < 0.01 ? '✓ OK' : `${gap > 0 ? '+' : ''}${gap.toFixed(2)}`}
                        </span>
                      ) : (
                        <span className="text-slate-600 text-xs italic">N/A</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-slate-500">Aucun compte configuré.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};