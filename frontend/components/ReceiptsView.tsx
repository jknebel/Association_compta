
import React, { useState, useRef } from 'react';
import { Receipt, Transaction } from '../../types';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2, Image as ImageIcon, Link2, Trash2, Calendar, DollarSign, ExternalLink } from 'lucide-react';
import { analyzeReceipt, processReceiptBackend } from '../services/geminiService';
import { uploadReceipt } from '../services/storageService';

interface ReceiptsViewProps {
    receipts: Receipt[];
    transactions: Transaction[];
    onAddReceipt: (receipt: Receipt) => void;
    onDeleteReceipt: (id: string) => void;
    onLinkReceipt: (receiptId: string, transactionId: string) => void;
}

export const ReceiptsView: React.FC<ReceiptsViewProps> = ({
    receipts,
    transactions,
    onAddReceipt,
    onDeleteReceipt,
    onLinkReceipt
}) => {
    const [isProcessing, setIsProcessing] = useState(false);
    const [dragActive, setDragActive] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Open receipt file (handles both URLs and base64 data URIs incl. PDFs)
    const openReceipt = (url: string, fileName: string) => {
        if (url.startsWith('data:')) {
            // Convert base64 data URI to blob and open in new tab
            try {
                const [header, b64] = url.split(',');
                const mimeMatch = header.match(/data:(.*?);/);
                const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
                const byteChars = atob(b64);
                const byteArray = new Uint8Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
                const blob = new Blob([byteArray], { type: mime });
                const blobUrl = URL.createObjectURL(blob);
                window.open(blobUrl, '_blank');
            } catch (e) {
                console.error('Failed to open data URI', e);
                window.open(url, '_blank');
            }
        } else {
            window.open(url, '_blank');
        }
    };

    // Filter out receipts that are already linked
    const unlinkedReceipts = receipts.filter(r => !r.linkedTransactionId);

    const handleDrag = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFiles(Array.from(e.dataTransfer.files));
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            handleFiles(Array.from(e.target.files));
        }
    };

    const handleFiles = async (files: File[]) => {
        setIsProcessing(true);

        for (const file of files) {
            try {
                if (file.size > 2 * 1024 * 1024) {
                    alert(`Le fichier ${file.name} est trop volumineux (> 2Mo). Ignore.`);
                    continue;
                }

                // 1. Upload to Storage
                const url = await uploadReceipt(file);

                // 2. Analyze with Gemini (requires base64 for now if not public url)
                // Since uploadReceipt might return base64 in guest mode or URL in cloud mode,
                // we need a reliable way to get base64 for Gemini.
                let base64ForGemini = "";
                if (url.startsWith('data:')) {
                    base64ForGemini = url.split(',')[1];
                } else {
                    // If it's a URL, fetch it to get blob -> base64 (CORS might be issue, skip AI if so)
                    try {
                        const resp = await fetch(url);
                        const blob = await resp.blob();
                        base64ForGemini = await new Promise<string>((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                            reader.readAsDataURL(blob);
                        });
                    } catch (e) {
                        console.warn("Could not fetch URL for AI analysis", e);
                    }
                }

                let analysis: any = {};
                let matchedTransactionId: string | null = null;
                if (base64ForGemini) {
                    try {
                        const result = await processReceiptBackend(base64ForGemini, file.type, transactions);
                        analysis = result.extracted;
                        matchedTransactionId = result.matchedTransactionId;
                    } catch (err) {
                        console.error("Backend receipt process failed:", err);
                        // Fallback could be basic analyzeReceipt, but we'll leave empty for now
                    }
                }

                const newReceipt: Receipt = {
                    id: `rcpt-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    url: url,
                    fileName: file.name,
                    uploadDate: new Date().toISOString().split('T')[0],
                    extractedDate: analysis?.date ?? null,
                    extractedAmount: analysis?.amount ?? null,
                    isAnalyzed: !!base64ForGemini,
                    linkedTransactionId: matchedTransactionId ?? null
                };

                onAddReceipt(newReceipt);

            } catch (e) {
                console.error("Error processing file", file.name, e);
            }
        }

        setIsProcessing(false);
    };

    // --- MATCHING LOGIC ---
    const findPotentialMatches = (receipt: Receipt) => {
        if (!receipt.extractedAmount && !receipt.extractedDate) return [];

        const scoredMatches = transactions.map(t => {
            // Rule 1: Not already linked
            if (t.receiptUrl) return { transaction: t, score: -1 };

            let score = 0;
            let amountMatches = false;

            // 1. Strict Amount Check (Tolerance 0.1)
            // If the receipt has an amount, it MUST match the transaction amount closely.
            if (receipt.extractedAmount) {
                if (Math.abs(Math.abs(t.amount) - receipt.extractedAmount) < 0.1) {
                    score += 10; // High weight for exact amount
                    amountMatches = true;
                } else {
                    return { transaction: t, score: -1 }; // Reject immediately if amount doesn't match
                }
            }

            // 2. Date Check: Justificatif date should be <= Virement (Transaction) date
            // Tolerance: Receipt is up to 30 days older than Virement, but never in the future
            if (receipt.extractedDate) {
                const rDate = new Date(receipt.extractedDate).getTime();
                const tDate = new Date(t.date).getTime();
                const diffDays = (tDate - rDate) / (1000 * 3600 * 24);

                // Receipt date is older than or equal to transaction date (allow 1 day timezone drift)
                if (diffDays >= -1 && diffDays <= 45) {
                    score += 5;
                    // Closer dates get more points
                    if (diffDays >= -1 && diffDays <= 7) score += 3;
                } else if (amountMatches) {
                    // Small penalty if dates don't align but amount matches exactly
                    score -= 5;
                } else {
                    // Reject if neither amount matches nor date is within bounds
                    return { transaction: t, score: -1 };
                }
            }

            // 3. Text/Description Match
            // Use transaction text to add bonus points if it resembles the file name
            if (receipt.fileName && t.description) {
                const safeFileName = receipt.fileName.toLowerCase();
                const words = t.description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                let textBonus = 0;

                words.forEach(word => {
                    if (safeFileName.includes(word)) {
                        textBonus += 2;
                    }
                });

                // Cap text bonus to avoid it outweighing amount/date
                score += Math.min(textBonus, 6);
            }

            return { transaction: t, score };
        });

        // Filter valid matches and sort by score descending
        return scoredMatches
            .filter(m => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(m => m.transaction);
    };

    return (
        <div className="p-8 max-w-7xl mx-auto h-full flex flex-col">
            <header className="mb-8">
                <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
                    <Upload className="text-blue-500" />
                    Ajouter Pièces Comptables
                </h2>
                <p className="text-slate-400 mt-2">
                    Déposez vos factures et reçus ici. L'IA tentera de les associer automatiquement à vos transactions existantes.
                </p>
            </header>

            {/* UPLOAD AREA */}
            <div
                className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center transition-all mb-8 ${dragActive ? 'border-blue-500 bg-blue-900/20' : 'border-slate-700 bg-slate-900 hover:border-slate-500'
                    }`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
            >
                {isProcessing ? (
                    <div className="flex flex-col items-center gap-3">
                        <Loader2 className="animate-spin text-blue-500" size={32} />
                        <p className="text-slate-300">Analyse par IA en cours...</p>
                    </div>
                ) : (
                    <>
                        <div className="bg-slate-800 p-4 rounded-full mb-4">
                            <FileText size={32} className="text-slate-400" />
                        </div>
                        <h3 className="text-lg font-medium text-slate-200 mb-2">Glissez-déposez vos fichiers ici</h3>
                        <p className="text-sm text-slate-500 mb-4">PDF, JPG, PNG acceptés</p>
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors font-medium text-sm"
                        >
                            Sélectionner des fichiers
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            accept="image/*,application/pdf"
                            className="hidden"
                            onChange={handleChange}
                        />
                    </>
                )}
            </div>

            {/* LIST OF RECEIPTS */}
            <div className="flex-1 overflow-y-auto">
                <h3 className="text-lg font-bold text-slate-200 mb-4 flex items-center gap-2">
                    <Link2 size={20} />
                    Pièces à traiter ({unlinkedReceipts.length})
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {unlinkedReceipts.map(receipt => {
                        const matches = findPotentialMatches(receipt);
                        const hasMatch = matches.length > 0;

                        return (
                            <div key={receipt.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-sm">
                                {/* PREVIEW HEADER — Clickable to open file */}
                                <div
                                    className="h-32 bg-slate-950 relative group cursor-pointer"
                                    onClick={() => openReceipt(receipt.url, receipt.fileName)}
                                    title="Cliquer pour ouvrir le fichier"
                                >
                                    {receipt.url.startsWith('data:image') || receipt.fileName.match(/\.(jpg|jpeg|png)$/i) ? (
                                        <img src={receipt.url} alt="receipt" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" />
                                    ) : (
                                        <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 group-hover:text-blue-400 transition-colors">
                                            <FileText size={48} />
                                            <span className="text-xs mt-2 text-slate-500 group-hover:text-blue-300">Cliquer pour ouvrir</span>
                                        </div>
                                    )}
                                    <div className="absolute top-2 right-2 p-1.5 bg-black/50 group-hover:bg-blue-600/80 rounded text-white backdrop-blur-sm transition-colors">
                                        <ExternalLink size={14} />
                                    </div>
                                </div>

                                {/* INFO BODY */}
                                <div className="p-4 flex-1 flex flex-col">
                                    <div className="flex justify-between items-start mb-2">
                                        <span className="text-sm font-medium text-slate-200 truncate pr-2" title={receipt.fileName}>{receipt.fileName}</span>
                                        <button onClick={() => onDeleteReceipt(receipt.id)} className="text-slate-600 hover:text-rose-500">
                                            <Trash2 size={16} />
                                        </button>
                                    </div>

                                    <div className="flex gap-4 text-xs text-slate-400 mb-4">
                                        <div className="flex items-center gap-1">
                                            <Calendar size={12} />
                                            {receipt.extractedDate || <span className="italic">?</span>}
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <DollarSign size={12} />
                                            {receipt.extractedAmount ? receipt.extractedAmount.toFixed(2) : <span className="italic">?</span>}
                                        </div>
                                    </div>

                                    {/* MATCHING SECTION */}
                                    <div className="mt-auto pt-4 border-t border-slate-800">
                                        {hasMatch ? (
                                            <div className="space-y-2">
                                                <div className="text-xs text-emerald-400 font-bold flex items-center gap-1">
                                                    <CheckCircle size={12} /> Suggestion trouvée
                                                </div>
                                                {matches.slice(0, 2).map(m => (
                                                    <button
                                                        key={m.id}
                                                        onClick={() => {
                                                            if (window.confirm(`Lier ce justificatif à la transaction :\n\n"${m.description}"\n${m.date} — CHF ${m.amount.toFixed(2)}\n\nConfirmer ?`)) {
                                                                onLinkReceipt(receipt.id, m.id);
                                                            }
                                                        }}
                                                        className="w-full text-left p-2 rounded bg-emerald-900/10 hover:bg-emerald-900/20 border border-emerald-900/30 text-xs transition-colors group"
                                                    >
                                                        <div className="text-slate-300 font-medium">{m.description}</div>
                                                        <div className="flex justify-between text-slate-500 mt-1">
                                                            <span>{m.date}</span>
                                                            <span className="group-hover:text-emerald-400">CHF {m.amount.toFixed(2)}</span>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="text-xs text-amber-500 flex items-center gap-1 bg-amber-900/10 p-2 rounded border border-amber-900/30">
                                                <AlertCircle size={12} /> Aucune correspondance évidente
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {unlinkedReceipts.length === 0 && !isProcessing && (
                    <div className="text-center py-12 text-slate-500">
                        Aucune pièce en attente.
                    </div>
                )}
            </div>
        </div>
    );
};
