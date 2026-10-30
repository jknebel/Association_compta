import React, { useState, useEffect } from 'react';
import { loginWithGoogle, loginWithEmail, registerWithEmail } from '../services/authService';
import { Lock, Mail, ArrowRight, AlertCircle, LayoutDashboard, User as UserIcon, Building2 } from 'lucide-react';
import { createUserProfile } from '../services/userService';
import { listAllOrganizations } from '../services/organizationService';
import { Organization } from '../types/rbac';
import { getAuth, sendEmailVerification } from 'firebase/auth';
import { app } from '../services/dataService';

const GoogleIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <svg className={className} viewBox="0 0 24 24">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
    />
  </svg>
);

interface LoginViewProps {
  onGuestAccess?: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onGuestAccess }) => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string>('TDGL');
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const currentDomain = window.location.hostname;

  // Charger les associations disponibles pour l'inscription
  useEffect(() => {
    const fetchOrgs = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlOrgId = params.get('org');
        const orgs = await listAllOrganizations();
        if (orgs.length > 0) {
          setOrganizations(orgs);
          if (urlOrgId && orgs.some(o => o.id === urlOrgId)) {
            setSelectedOrgId(urlOrgId);
          } else {
            const tdglOrg = orgs.find(o => o.name?.toLowerCase().includes('tdgl') || o.id === 'TDGL');
            setSelectedOrgId(tdglOrg ? tdglOrg.id : orgs[0].id);
          }
        } else {
          setOrganizations([{
            id: 'TDGL',
            name: 'TDGL',
            description: 'Association TDGL',
            createdAt: Date.now(),
            createdBy: 'system',
            inviteCode: '',
            customFields: []
          }]);
          setSelectedOrgId('TDGL');
        }
      } catch (err) {
        console.error("Erreur lors de la récupération des associations:", err);
      }
    };
    fetchOrgs();
  }, []);

  // Détection des paramètres d'invitation
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlOrgId = params.get('org');
    if (urlOrgId) {
      setSelectedOrgId(urlOrgId);
      setIsSignUp(true);
      setMessage("Inscrivez-vous ci-dessous (Prénom, Nom, Email). Un e-mail de vérification vous sera envoyé pour valider votre compte.");
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (isSignUp) {
        if (!firstName.trim() || !lastName.trim()) {
          throw new Error("Veuillez saisir votre prénom et nom.");
        }
        const userCredential = await registerWithEmail(email, password);
        const user = userCredential.user;
        
        const selectedOrg = organizations.find(o => o.id === selectedOrgId);
        const orgName = selectedOrg ? selectedOrg.name : selectedOrgId;

        // Créer le profil avec obligation de vérifier l'adresse e-mail (anti-robot, expiration 10 jours)
        await createUserProfile(user.uid, {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: user.email || email,
          orgId: selectedOrgId,
          orgName: orgName,
          emailVerified: false,
          emailVerificationRequired: true,
        });

        // Envoyer l'email de vérification
        await sendEmailVerification(user);
        setMessage("Compte créé ! Un e-mail de vérification vous a été envoyé.");

        // Nettoyer les paramètres ?org=&code= pour aller directement à l'écran de vérification du mail
        if (window.location.search) {
          window.history.replaceState({}, '', window.location.pathname);
        }
      } else {
        await loginWithEmail(email, password);
        if (window.location.search) {
          window.history.replaceState({}, '', window.location.pathname);
        }
      }
    } catch (err: any) {
      console.error("Auth Error:", err);
      let msg = err.message || "Une erreur est survenue.";
      if (err.code === 'auth/invalid-credential') msg = "Email ou mot de passe incorrect.";
      if (err.code === 'auth/user-not-found') msg = "Aucun utilisateur trouvé avec cet email.";
      if (err.code === 'auth/wrong-password') msg = "Mot de passe incorrect.";
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
      const result = await loginWithGoogle();
      // On check si c'est un nouvel utilisateur pour créer son profil
      // result.additionalUserInfo n'est plus dispo dans le nouveau SDK facilement sans getAdditionalUserInfo
      // On va juste essayer de créer le profil, s'il existe déjà la fonction merge/ignore
      if (result.user) {
        const names = (result.user.displayName || "").split(" ");
        const selectedOrg = organizations.find(o => o.id === selectedOrgId);
        const orgName = selectedOrg ? selectedOrg.name : (selectedOrgId || 'TDGL');
        await createUserProfile(result.user.uid, {
          firstName: names[0] || "",
          lastName: names.slice(1).join(" ") || "",
          email: result.user.email || "",
          orgId: selectedOrgId || 'TDGL',
          orgName: orgName,
        });
      }
    } catch (err: any) {
      console.error("Google Auth Error:", err);
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
        <div className="p-8">
          <h2 className="text-xl font-semibold text-white mb-2 text-center">
            {isSignUp ? "Créer un compte" : "Connexion"}
          </h2>
          {isSignUp && (
            <p className="text-xs text-slate-400 text-center mb-6">
              Inscrivez-vous avec votre adresse email. Vos accès aux organisations et comptabilités seront reconnus automatiquement.
            </p>
          )}

          {message && (
            <div className="mb-4 p-3 bg-blue-900/20 border border-blue-900/50 rounded-lg text-sm text-blue-400 text-center">
              {message}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Prénom</label>
                    <div className="relative">
                      <UserIcon className="absolute left-3 top-3 text-slate-500" size={18} />
                      <input
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                        placeholder="Jean"
                        required={isSignUp}
                      />
                    </div>
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Nom</label>
                    <div className="relative">
                      <input
                        type="text"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2.5 px-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                        placeholder="Dupont"
                        required={isSignUp}
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Association</label>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-3 text-slate-500" size={18} />
                    <select
                      value={selectedOrgId}
                      onChange={(e) => setSelectedOrgId(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2.5 pl-10 pr-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                      required={isSignUp}
                    >
                      {organizations.map((org) => (
                        <option key={org.id} value={org.id} className="bg-slate-900 text-white">
                          {org.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Sélectionnez l'association à laquelle vous appartenez.</p>
                </div>
              </>
            )}

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
                  minLength={6}
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
                  {isSignUp ? "S'inscrire" : "Connexion"}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => { setIsSignUp(!isSignUp); setError(null); setMessage(null); }}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              {isSignUp ? "Déjà un compte ? Connectez-vous" : "Pas de compte ? Inscrivez-vous"}
            </button>
          </div>

          <div className="my-6 flex items-center gap-4">
            <div className="h-px bg-slate-800 flex-1" />
            <span className="text-xs text-slate-500 font-medium">OU</span>
            <div className="h-px bg-slate-800 flex-1" />
          </div>

          <div className="space-y-3">
            <button
              onClick={handleGoogleLogin}
              disabled={isLoading}
              className="w-full bg-white hover:bg-slate-50 text-slate-800 font-medium py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2.5 shadow-sm hover:shadow active:scale-[0.99] disabled:opacity-50"
            >
              <GoogleIcon />
              <span>Continuer avec Google</span>
            </button>
          </div>

        </div>
      </div>

      <div className="mt-8 text-center text-slate-500 text-xs">
        <p>En mode connecté, vos données sont sauvegardées dans le cloud.</p>
      </div>
    </div>
  );
};
