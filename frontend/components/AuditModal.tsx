import React from 'react';
import ReactMarkdown from 'react-markdown';
import { X, Printer, CheckCircle, AlertTriangle } from 'lucide-react';

interface AuditModalProps {
    isOpen: boolean;
    onClose: () => void;
    report: string;
    loading: boolean;
}

export const AuditModal: React.FC<AuditModalProps> = ({ isOpen, onClose, report, loading }) => {
    if (!isOpen) return null;

    const handlePrint = () => {
        window.print();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white text-slate-900 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">

                {/* Header */}
                <div className="p-6 bg-slate-50 border-b border-slate-200 flex justify-between items-center print:hidden">
                    <div>
                        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                            <CheckCircle className="text-emerald-600" />
                            Audit & Clôture Comptable
                        </h2>
                        <p className="text-slate-500 text-sm mt-1">Rapport généré par l'Assistant IA</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                    >
                        <X size={24} className="text-slate-500" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-8 print:p-0 bg-white">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-64 gap-4">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
                            <p className="text-slate-500 animate-pulse">L'expert IA analyse vos comptes...</p>
                        </div>
                    ) : (
                        <div className="prose prose-slate max-w-none print:prose-sm">
                            <div className="mb-6 p-4 bg-blue-50 border border-blue-100 rounded-lg text-sm text-blue-800 flex items-start gap-3 print:hidden">
                                <AlertTriangle size={20} className="shrink-0 mt-0.5" />
                                <p>Ce rapport est généré par une intelligence artificielle. Il fournit une assistance à la vérification mais ne remplace pas la signature légale d'un trésorier ou d'un expert-comptable humain.</p>
                            </div>

                            <div className="audit-content">
                                <ReactMarkdown>{report}</ReactMarkdown>
                            </div>

                            <div className="mt-12 pt-8 border-t border-slate-200 flex justify-between text-sm text-slate-400 print:flex">
                                <span>Généré par AssoCompta AI</span>
                                <span>{new Date().toLocaleDateString()}</span>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-6 bg-slate-50 border-t border-slate-200 flex justify-end gap-3 print:hidden">
                    <button
                        onClick={onClose}
                        className="px-6 py-2 rounded-lg text-slate-600 hover:bg-slate-200 font-medium transition-colors"
                    >
                        Fermer
                    </button>
                    {!loading && (
                        <button
                            onClick={handlePrint}
                            className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg shadow-blue-500/20 flex items-center gap-2 transition-colors"
                        >
                            <Printer size={18} />
                            Imprimer / PDF
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
