import React, { useState } from 'react';
import { loginWithGoogle, loginWithEmail, registerWithEmail } from '../services/authService';
import { Lock, Mail, Chrome, ArrowRight, CheckCircle, AlertCircle, LayoutDashboard, UserX, Copy } from 'lucide-react';

interface LoginViewProps {
  onGuestAccess: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onGuestAccess }) => {
  const [mode, setMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentDomain = window.location.hostname;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
        if (mode === 'LOGIN') {
            await loginWithEmail(email, password);
        } else {
            await registerWithEmail(email, password);
        }
    } catch (err: any) {
        console.error("Auth Error:", err);
        let msg = "Une erreur est survenue.";
        if (err.code === 'auth/invalid-credential') msg = "Email ou mot de passe incorrect.";
        if (err.code === 'auth/email-already-in-use') msg = "Cet email est déjà utilisé.";
        if (err.code === 'auth/weak-password') msg = "Le mot de passe doit faire au moins 6 caractères.";
        setError(msg);
    } finally {
        setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await loginWithGoogle();
    } catch (err: any) {
      console.error("Google Auth Error:", err);
      
      // Gestion précise des erreurs courantes
      if (err.code === 'auth/popup-closed-by-user') {
          setError("La fenêtre de connexion a été fermée avant la fin.");
      } else if (err.code === 'auth/unauthorized-domain') {
          setError(`Domaine non autorisé. Veuillez ajouter "${currentDomain}" dans Firebase.`);
      } else if (err.code === 'auth/operation-not-allowed') {
          setError("La connexion Google n'est pas activée. Allez dans Firebase > Authentication > Sign-in method et activez 'Google'.");
      } else if (err.code === 'auth/popup-blocked') {
          setError("Le navigateur a bloqué la fenêtre pop-up. Veuillez l'autoriser.");
      } else {
          setError(`Erreur (${err.code}): Vérifiez la configuration Firebase.`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
      <div className="mb-8 text-center">
        <div className="flex items-center justify-center gap-3 mb-4">
           <div className="bg-blue-600 p-3 rounded-xl shadow-lg shadow-blue-900/20">
             <LayoutDashboard size={32} className="text-white" />
           </div>
        </div>
        <h1 className="text-3xl font-bold text-white tracking-tight">
          <span className="text-blue-500">Asso</span>Compta AI
        </h1>
        <p className="text-slate-400 mt-2 text-sm">Votre expert comptable intelligent et collaboratif</p>
      </div>

      <div className="w-full max-w-md bg-slate-900 rounded-2xl shadow-xl border border-slate-800 overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-slate-800">
          <button 
            onClick={() => setMode('LOGIN')}
            className={`flex-1 py-4 text-sm font-medium transition-colors ${mode === 'LOGIN' ? 'bg-slate-800 text-white border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Se connecter
          </button>
          <button 
            onClick={() => setMode('REGISTER')}
            className={`flex-1 py-4 text-sm font-medium transition-colors ${mode === 'REGISTER' ? 'bg-slate-800 text-white border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Créer un compte
          </button>
        </div>

        <div className="p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 text-slate-500" size={18} />
                <input 
                  type="email" 
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  placeholder="exemple@asso.com"
                  required
                />
              </div>
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Mot de passe</label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 text-slate-500" size={18} />
                <input 
                  type="password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-900/20 border border-red-900/50 rounded-lg flex items-start gap-2 text-sm text-red-400 animate-in fade-in slide-in-from-top-2">
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <span className="break-words">{error}</span>
              </div>
            )}

            <button 
              type="submit"
              disabled={isLoading}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 mt-2 shadow-lg shadow-blue-900/20"
            >
              {isLoading ? (
                <span className="animate-pulse">Chargement...</span>
              ) : (
                <>
                  {mode === 'LOGIN' ? 'Connexion' : "S'inscrire"}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          <div className="my-6 flex items-center gap-4">
            <div className="h-px bg-slate-800 flex-1" />
            <span className="text-xs text-slate-500 font-medium">OU</span>
            <div className="h-px bg-slate-800 flex-1" />
          </div>

          <div className="space-y-3">
            <button 
                onClick={handleGoogleLogin}
                disabled={isLoading}
                className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 shadow-md"
            >
                <Chrome size={18} className="text-blue-600" />
                Continuer avec Google
            </button>

            <button 
                onClick={onGuestAccess}
                disabled={isLoading}
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 border border-slate-700"
            >
                <UserX size={18} />
                Mode Invité (Données Locales)
            </button>
          </div>

        </div>
      </div>
      
      <div className="mt-8 w-full max-w-md space-y-4">
        <div className="text-center text-slate-500 text-xs">
          <p>En mode connecté, vos données sont sauvegardées dans le cloud.</p>
        </div>

        {/* DOMAIN HELPER */}
        <div className="p-4 bg-slate-900/50 border border-slate-800 rounded-lg text-xs">
           <div className="flex items-center gap-2 text-slate-400 mb-2 font-semibold">
               <AlertCircle size={14} />
               Configuration Firebase (Preview)
           </div>
           <p className="text-slate-500 mb-2">Pour que Google Login fonctionne ici, ajoutez ce domaine aux "Authorized domains" dans Firebase :</p>
           <div 
             className="bg-black/50 border border-slate-700 rounded p-2 text-blue-400 font-mono break-all cursor-pointer hover:bg-black/70 transition-colors flex justify-between items-center group"
             onClick={() => navigator.clipboard.writeText(currentDomain)}
             title="Cliquer pour copier"
           >
              {currentDomain}
              <Copy size={12} className="opacity-50 group-hover:opacity-100" />
           </div>
        </div>
      </div>
    </div>
  );
};