import React from 'react';
import { Clock, RefreshCcw } from 'lucide-react';
import { useAuthContext } from '../contexts/AppContext';

interface PendingApprovalProps {
    orgName: string;
}

export const PendingApproval: React.FC<PendingApprovalProps> = ({ orgName }) => {
    const { refreshProfile } = useAuthContext();
    const [isRefreshing, setIsRefreshing] = React.useState(false);

    const handleRefresh = async () => {
        setIsRefreshing(true);
        await refreshProfile();
        // Le délai aide pour le feedback visuel
        setTimeout(() => setIsRefreshing(false), 800);
    };

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
            <div className="max-w-md w-full bg-slate-900 rounded-2xl shadow-xl border border-slate-800 p-8 text-center">
                <div className="flex justify-center mb-6">
                    <div className="bg-amber-900/30 p-4 rounded-full border border-amber-800/50">
                        <Clock size={40} className="text-amber-500" />
                    </div>
                </div>

                <h2 className="text-2xl font-bold text-white mb-4">Demande en attente</h2>
                
                <p className="text-slate-400 mb-6">
                    Votre demande pour rejoindre l'organisation <strong className="text-white">{orgName}</strong> a bien été envoyée.
                    Elle est actuellement en attente de validation par un administrateur.
                </p>

                <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 mb-8">
                    <p className="text-sm text-slate-500">
                        Vous recevrez un email dès que votre accès sera approuvé.
                        Si vous pensez que c'est déjà fait, vous pouvez actualiser votre profil.
                    </p>
                </div>

                <div className="flex flex-col gap-3">
                    <button 
                        onClick={handleRefresh}
                        disabled={isRefreshing}
                        className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white px-6 py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2 font-medium"
                    >
                        <RefreshCcw size={18} className={isRefreshing ? "animate-spin" : ""} />
                        {isRefreshing ? "Actualisation..." : "Actualiser mon statut"}
                    </button>
                    
                    <button 
                        onClick={() => window.location.href = '/'}
                        className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 px-6 py-2.5 rounded-lg transition-colors font-medium"
                    >
                        Retour à l'accueil
                    </button>
                </div>
            </div>
        </div>
    );
};
