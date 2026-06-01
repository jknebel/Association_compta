
import React, { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, FileSpreadsheet } from 'lucide-react';
import { parseBankStatementPDF } from '../services/geminiService';
import { parseExcelLedger } from '../services/excelService';
import { Account, Transaction, AccountType, TransactionStatus, Receipt } from '../../types';

import { User } from 'firebase/auth';

interface UploadViewProps {
  accounts: Account[];
  transactions: Transaction[];
  receipts: Receipt[];
  user: User | null;
  onProcessComplete: (newTransactions: Transaction[], newAccounts: Account[], matchedReceiptIds: string[]) => void;
  onProcessingChange?: (isProcessing: boolean) => void;
  globalContext?: string;
  isUploading: boolean;
  uploadError: string | null;
  onUploadFile: (file: File, mode: 'PDF' | 'EXCEL') => void;
}

export const UploadView: React.FC<UploadViewProps> = ({ 
  accounts, 
  transactions, 
  receipts, 
  user, 
  onProcessComplete, 
  onProcessingChange, 
  globalContext,
  isUploading,
  uploadError,
  onUploadFile
}) => {
  const [activeMode, setActiveMode] = useState<'PDF' | 'EXCEL'>('PDF');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    
    onUploadFile(file, activeMode);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onUploadFile(file, activeMode);
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
          {!isUploading ? (
            <div
              className={`w-full max-w-lg border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer transition-all group ${
                isDragging 
                  ? 'border-blue-400 bg-blue-900/20 scale-[1.02]'
                  : activeMode === 'PDF' ? 'border-blue-800 hover:border-blue-600 hover:bg-slate-800' : 'border-green-800 hover:border-green-600 hover:bg-slate-800'
                }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
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

          {uploadError && (
            <div className="mt-6 p-4 bg-red-900/20 text-red-400 rounded-lg flex items-center gap-3 border border-red-900/50">
              <AlertCircle size={20} />
              <span>{uploadError}</span>
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
