import React, { useState } from 'react';
import { Transaction } from '../../types';
import { TransactionComment } from '../types/rbac';
import { X, MessageSquare, Send, User } from 'lucide-react';
import { formatDate } from '../services/formatUtils';

interface TransactionCommentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  transaction: Transaction;
  onSaveComments: (comments: TransactionComment[]) => void;
  currentUserEmail?: string;
  currentUserName?: string;
  currentUserRole?: string;
}

export const TransactionCommentsModal: React.FC<TransactionCommentsModalProps> = ({
  isOpen,
  onClose,
  transaction,
  onSaveComments,
  currentUserEmail = '',
  currentUserName = '',
  currentUserRole = 'viewer'
}) => {
  const [newComment, setNewComment] = useState('');

  if (!isOpen) return null;

  const comments = transaction.comments || [];

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    const roleLabel = currentUserRole === 'admin' 
      ? 'Admin' 
      : currentUserRole === 'comptable' 
        ? 'Comptable' 
        : 'Lecteur';

    const commentItem: TransactionComment = {
      id: `comm-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      authorEmail: currentUserEmail,
      authorName: currentUserName || currentUserEmail.split('@')[0] || 'Utilisateur',
      authorRole: roleLabel,
      text: newComment.trim(),
      createdAt: Date.now()
    };

    const updated = [...comments, commentItem];
    onSaveComments(updated);
    setNewComment('');
  };

  const formatCommentDate = (timestamp: number) => {
    try {
      const d = new Date(timestamp);
      return `${d.toLocaleDateString('fr-CH')} à ${d.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      return '';
    }
  };

  const getRoleBadgeClass = (role: string) => {
    switch (role.toLowerCase()) {
      case 'admin':
        return 'bg-purple-900/30 text-purple-300 border-purple-800/50';
      case 'comptable':
        return 'bg-emerald-900/30 text-emerald-300 border-emerald-800/50';
      case 'lecteur':
      case 'viewer':
      default:
        return 'bg-amber-900/30 text-amber-300 border-amber-800/50';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-950/70">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-900/30 text-blue-400 rounded-lg border border-blue-800/40">
              <MessageSquare size={18} />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base">Notes & Commentaires d'audit</h3>
              <p className="text-xs text-slate-400">
                {formatDate(transaction.date)} &bull; {transaction.description} &bull; 
                <span className={`font-semibold ml-1 ${transaction.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  CHF {transaction.amount.toFixed(2)}
                </span>
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Comment list */}
        <div className="p-4 flex-1 overflow-y-auto space-y-3 bg-slate-900/50">
          {comments.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <MessageSquare size={36} className="mx-auto mb-2 opacity-30 text-slate-400" />
              <p className="text-sm">Aucun commentaire pour cette transaction.</p>
              <p className="text-xs text-slate-600 mt-1">
                Les lecteurs et comptables peuvent poser une question ou ajouter une observation ici.
              </p>
            </div>
          ) : (
            comments.map((c) => (
              <div 
                key={c.id} 
                className="p-3 bg-slate-950/80 border border-slate-800 rounded-lg space-y-1.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-200 flex items-center gap-1">
                      <User size={12} className="text-slate-500" />
                      {c.authorName || c.authorEmail}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${getRoleBadgeClass(c.authorRole)}`}>
                      {c.authorRole}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    {formatCommentDate(c.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-slate-300 whitespace-pre-wrap pl-4 border-l-2 border-slate-700">
                  {c.text}
                </p>
              </div>
            ))
          )}
        </div>

        {/* New comment form */}
        <form onSubmit={handleAddComment} className="p-3 border-t border-slate-800 bg-slate-950 flex flex-col gap-2">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Écrire un commentaire, poser une question d'audit..."
            rows={2}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none"
          />
          <div className="flex justify-between items-center">
            <span className="text-[11px] text-slate-500">
              Posté en tant que <span className="text-slate-300 font-medium">{currentUserEmail}</span> ({currentUserRole})
            </span>
            <button
              type="submit"
              disabled={!newComment.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
            >
              <Send size={13} />
              Envoyer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
