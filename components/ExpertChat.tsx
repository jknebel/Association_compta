import React, { useState, useRef, useEffect } from 'react';
import { Transaction, Account } from '../types';
import { auditLedger, chatWithAccountant } from '../services/geminiService';
import { Send, Bot, User, Sparkles, BrainCircuit } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ExpertChatProps {
  transactions: Transaction[];
  accounts: Account[];
}

interface Message {
  role: 'user' | 'model';
  text: string;
  isThinking?: boolean;
}

export const ExpertChat: React.FC<ExpertChatProps> = ({ transactions, accounts }) => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', text: "Bonjour ! Je suis votre Expert Comptable IA. Je peux auditer vos comptes, trouver des erreurs ou répondre à vos questions financières. Comment puis-je vous aider ?" }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleAudit = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setMessages(prev => [...prev, { role: 'user', text: "Peux-tu réaliser un audit complet de la comptabilité actuelle ?" }]);

    try {
      const result = await auditLedger(transactions, accounts);
      setMessages(prev => [...prev, { role: 'model', text: result, isThinking: true }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'model', text: "J'ai rencontré une erreur lors de l'audit. Veuillez vérifier votre clé API." }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    
    const userText = input;
    setInput('');
    setIsLoading(true);
    setMessages(prev => [...prev, { role: 'user', text: userText }]);

    try {
      const response = await chatWithAccountant(messages, { transactions, accounts }, userText);
      setMessages(prev => [...prev, { role: 'model', text: response || "Je n'ai pas pu générer de réponse." }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'model', text: "Désolé, j'ai rencontré une erreur de connexion avec le service IA." }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`flex gap-3 max-w-3xl ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-blue-600' : 'bg-indigo-600'}`}>
                {msg.role === 'user' ? <User size={16} className="text-white" /> : <Bot size={16} className="text-white" />}
              </div>
              
              <div className={`p-4 rounded-2xl shadow-sm text-sm leading-relaxed ${
                msg.role === 'user' 
                  ? 'bg-blue-600 text-white rounded-tr-none' 
                  : 'bg-slate-800 text-slate-100 rounded-tl-none border border-slate-700'
              }`}>
                 {msg.isThinking && (
                   <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400 mb-2 pb-2 border-b border-indigo-500/30">
                     <BrainCircuit size={14} />
                     <span>Analyse Approfondie (Gemini 3 Pro)</span>
                   </div>
                 )}
                 {msg.role === 'model' ? (
                   <div className="prose prose-sm prose-invert max-w-none">
                     <ReactMarkdown>{msg.text}</ReactMarkdown>
                   </div>
                 ) : (
                   msg.text
                 )}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
             <div className="bg-slate-800 p-4 rounded-2xl rounded-tl-none shadow-sm border border-slate-700 flex items-center gap-2">
                <LoaderDots />
                <span className="text-xs text-slate-400 font-medium animate-pulse">Réflexion en cours...</span>
             </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 bg-slate-900 border-t border-slate-800">
        <div className="max-w-4xl mx-auto flex flex-col gap-3">
           {/* Quick Actions */}
           <div className="flex gap-2">
             <button 
               onClick={handleAudit}
               disabled={isLoading}
               className="flex items-center gap-2 px-3 py-1.5 bg-indigo-900/30 text-indigo-400 rounded-full text-xs font-medium hover:bg-indigo-900/50 transition-colors disabled:opacity-50"
             >
               <Sparkles size={14} />
               Lancer l'Audit Complet
             </button>
           </div>

           {/* Input Area */}
           <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Posez une question à votre expert comptable..."
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 focus:ring-2 focus:ring-indigo-500 focus:outline-none shadow-sm text-slate-200 placeholder-slate-500"
              disabled={isLoading}
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="bg-indigo-600 text-white p-3 rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-md transition-all active:scale-95"
            >
              <Send size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const LoaderDots = () => (
  <div className="flex space-x-1">
    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce"></div>
  </div>
);