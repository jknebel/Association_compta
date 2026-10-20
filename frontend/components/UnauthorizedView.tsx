import React, { useEffect } from 'react';
import { ShieldAlert, LogOut, RefreshCw } from 'lucide-react';
import { logout } from '../services/authService';

interface UnauthorizedViewProps {
    email: string;
    onRefresh: () => void;
    isRefreshing: boolean;
}

export const UnauthorizedView: React.FC<UnauthorizedViewProps> = ({ email, onRefresh, isRefreshing }) => {
    // Poll automatically every 6 seconds so as soon as the admin grants access, the user enters automatically
    useEffect(() => {
        const interval = setInterval(() => {
            if (!isRefreshing) {
                onRefresh();
            }
        }, 6000);
        return () => clearInterval(interval);
    }, [onRefresh, isRefreshing]);

    const handleLogout = async () => {
        await logout();
        window.location.href = '/';
    };

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 text-slate-200">
            <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 md:p-8 text-center shadow-xl">
                <div className="w-16 h-16 bg-amber-900/30 text-amber-500 rounded-full flex items-center justify-center mx-auto mb-5 border border-amber-800/50">
                    <ShieldAlert size={32} />
                </div>

                <h1 className="text-xl font-bold text-white mb-2">Accès en attente</h1>
                <p className="text-xs text-slate-400 mb-5">
                    Compte connecté : <span className="text-slate-200 font-semibold">{email}</span>
                </p>

                <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 mb-6 text-sm text-slate-300 leading-relaxed">
                    Vous n'avez pas encore d'accès. Veuillez voir avec votre administrateur.
                </div>

                <div className="flex flex-col gap-3">
                    <button
                        onClick={onRefresh}
                        disabled={isRefreshing}
                        className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-blue-900/30 cursor-pointer"
                    >
                        <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
                        {isRefreshing ? "Vérification en cours..." : "Vérifier mes accès"}
                    </button>

                    <button
                        onClick={handleLogout}
                        className="w-full py-2.5 bg-slate-950 hover:bg-red-950/30 text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-900/50 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 cursor-pointer"
                    >
                        <LogOut size={16} />
                        Se déconnecter
                    </button>
                </div>
            </div>
        </div>
    );
};
