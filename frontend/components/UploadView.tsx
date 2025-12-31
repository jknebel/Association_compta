
import React, { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, FileSpreadsheet } from 'lucide-react';
import { parseBankStatementPDF } from '../services/geminiService';
import { parseExcelLedger } from '../services/excelService';
import { Account, Transaction, AccountType, TransactionStatus, Receipt } from '../../types';

import { User } from 'firebase/auth';

interface UploadViewProps {
  accounts: Account[];
  transactions: Transaction[]; // Ajout de l'historique
  receipts: Receipt[]; // Ajout des reçus pour le matching
  user: User | null; // Pass user for API Context
  onProcessComplete: (newTransactions: Transaction[], newAccounts: Account[], matchedReceiptIds: string[]) => void;
}

export const UploadView: React.FC<UploadViewProps> = ({ accounts, transactions, receipts, user, onProcessComplete }) => {
  const [activeMode, setActiveMode] = useState<'PDF' | 'EXCEL'>('PDF');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const matchTransactionsWithReceipts = (newTxns: Transaction[]): { processedTxns: Transaction[], matchedReceiptIds: string[] } => {
    const matchedIds: string[] = [];
    const unlinkedReceipts = receipts.filter(r => !r.linkedTransactionId);

    const processedTxns = newTxns.map(txn => {
      // If already has receipt, skip
      if (txn.receiptUrl) return txn;

      // Find best match in unlinked receipts
      const match = unlinkedReceipts.find(r => {
        if (matchedIds.includes(r.id)) return false; // Already taken by another txn in this batch

        let isMatch = false;
        // Check Amount matches (tolerance 0.1)
        if (r.extractedAmount && Math.abs(Math.abs(txn.amount) - r.extractedAmount) < 0.1) {
          // Check Date matches (tolerance 7 days)
          if (r.extractedDate) {
            const d1 = new Date(r.extractedDate).getTime();
            const d2 = new Date(txn.date).getTime();
            const diff = Math.abs(d1 - d2) / (1000 * 3600 * 24);
            if (diff <= 7) isMatch = true;
          }
        }
        return isMatch;
      });

      if (match) {
        matchedIds.push(match.id);
        return { ...txn, receiptUrl: match.url };
      }
      return txn;
    });

    return { processedTxns, matchedReceiptIds: matchedIds };
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setError(null);

    try {
      let rawTransactions: Transaction[] = [];

      if (activeMode === 'PDF') {
        // PDF LOGIC
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
              const result = await parseBankStatementPDF(base64Data, accounts, transactions, userId);
              if (!result || !result.transactions) throw new Error("Échec de l'extraction des transactions.");

              rawTransactions = result.transactions.map((t: any, idx: number) => ({
                id: `txn-${Date.now()}-${idx}`,
                date: t.date,
                description: t.description,
                amount: t.amount,
                status: t.matchedAccountCode ? TransactionStatus.REVIEW_NEEDED : TransactionStatus.PENDING,
                accountId: t.matchedAccountCode
                  ? accounts.find(a => a.code === t.matchedAccountCode)?.id
                  : undefined,
                detectedMemberName: t.detectedMemberName,
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
        // EXCEL LOGIC
        rawTransactions = await parseExcelLedger(file);
      }

      // PERFORM MATCHING WITH RECEIPTS
      const { processedTxns, matchedReceiptIds } = matchTransactionsWithReceipts(rawTransactions);

      onProcessComplete(processedTxns, [], matchedReceiptIds);

    } catch (err: any) {
      setError(err.message || "Erreur de lecture du fichier.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="bg-slate-900 rounded-xl shadow-lg border border-slate-800 overflow-hidden">
        {/* Header with Tabs */}
        <div className="border-b border-slate-800">
          <div className="p-8 pb-4">
            <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
              <Upload className="text-blue-500" />
              Importer des Données
            </h2>
            <p className="text-slate-400 mt-2">
              Ajoutez des transactions à votre comptabilité. L'IA utilisera votre historique pour mieux catégoriser.
            </p>
          </div>
          <div className="flex px-8 gap-6">
            <button
              onClick={() => setActiveMode('PDF')}
              className={`pb-4 text-sm font-medium border-b-2 transition-colors ${activeMode === 'PDF' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            >
              Relevé Bancaire (PDF)
            </button>
            <button
              onClick={() => setActiveMode('EXCEL')}
              className={`pb-4 text-sm font-medium border-b-2 transition-colors ${activeMode === 'EXCEL' ? 'border-green-500 text-green-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
            >
              Journal Existant (Excel)
            </button>
          </div>
        </div>

        <div className="p-12 flex flex-col items-center justify-center bg-slate-900/50">
          {!isProcessing ? (
            <div
              className={`w-full max-w-lg border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer transition-all group ${activeMode === 'PDF' ? 'border-blue-800 hover:border-blue-600 hover:bg-slate-800' : 'border-green-800 hover:border-green-600 hover:bg-slate-800'
                }`}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className={`h-16 w-16 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform ${activeMode === 'PDF' ? 'bg-blue-900/50 text-blue-400' : 'bg-green-900/50 text-green-400'
                }`}>
                {activeMode === 'PDF' ? <FileText size={32} /> : <FileSpreadsheet size={32} />}
              </div>
              <h3 className="text-lg font-semibold text-slate-200">
                Cliquez pour importer {activeMode === 'PDF' ? 'PDF' : 'Excel'}
              </h3>
              <p className="text-sm text-slate-500 mt-1">ou glissez-déposez le fichier ici</p>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept={activeMode === 'PDF' ? "application/pdf" : ".xlsx, .xls"}
                onChange={handleFileUpload}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10">
              <Loader2 className={`animate-spin h-12 w-12 mb-4 ${activeMode === 'PDF' ? 'text-blue-500' : 'text-green-500'}`} />
              <h3 className="text-lg font-medium text-slate-200">Traitement du fichier...</h3>
              <p className="text-slate-500 text-sm">
                {activeMode === 'PDF' ? "L'IA analyse et cherche des justificatifs existants..." : 'Lecture des lignes Excel et matching...'}
              </p>
            </div>
          )}

          {error && (
            <div className="mt-6 p-4 bg-red-900/20 text-red-400 rounded-lg flex items-center gap-3 border border-red-900/50">
              <AlertCircle size={20} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="bg-slate-900 p-6 border-t border-slate-800">
          <h4 className="font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <CheckCircle size={16} />
            Instructions
          </h4>
          <ul className="text-sm text-slate-500 space-y-1 ml-6 list-disc">
            <li>Si vous avez déjà uploadé des reçus dans l'onglet "Pièces Comptables", ils seront automatiquement liés s'ils correspondent (Date & Montant).</li>
            {activeMode === 'PDF' && <li>L'IA apprendra de vos transactions précédentes pour assigner les comptes.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
};
