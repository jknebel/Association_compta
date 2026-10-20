import React, { useState, useEffect } from 'react';
import { ShieldAlert, LogOut, RefreshCw, Mail, Building2, Send, Key, ChevronDown, ChevronUp } from 'lucide-react';
import { logout } from '../services/authService';
import { useAuthContext } from '../contexts/AppContext';
import { 
  getUserPendingInvitations, 
  requestToJoinOrganization, 
  getOrganizationByInviteCode 
} from '../services/organizationService';

interface UnauthorizedViewProps {
  email: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export const UnauthorizedView: React.FC<UnauthorizedViewProps> = ({
  email,
  onRefresh,
  isRefreshing = false
}) => {
  const { user, userProfile } = useAuthContext();
  const [pendingRequests, setPendingRequests] = useState<Array<{ orgId: string; orgName: string; inviteId: string; requestedAt: number }>>([]);
  const [loadingInfo, setLoadingInfo] = useState(true);
  
  const [showCodeInput, setShowCodeInput] = useState<boolean>(false);
  const [inviteCodeInput, setInviteCodeInput] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchStatus = async () => {
    if (!email) return;
    setLoadingInfo(true);
    try {
      const pending = await getUserPendingInvitations(email);
      setPendingRequests(pending);
    } catch (e) {
      console.error("Error loading pending requests:", e);
    } finally {
      setLoadingInfo(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, [email]);

  // Vérification automatique toutes les 6 secondes pour détecter dès que l'admin attribue un rôle
  useEffect(() => {
    if (!onRefresh) return;
    const interval = setInterval(() => {
      onRefresh();
    }, 6000);
    return () => clearInterval(interval);
  }, [onRefresh]);

  const handleLogout = async () => {
    try {
      await logout();
      window.location.href = '/';
    } catch (e) {
      console.error("Logout error", e);
    }
  };

  const handleSendJoinRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      if (!inviteCodeInput.trim()) {
        throw new Error("Veuillez saisir le code d'invitation fourni par votre administrateur.");
      }

      const orgByCode = await getOrganizationByInviteCode(inviteCodeInput.trim());
      if (!orgByCode) {
        throw new Error("Code d'invitation invalide ou expiré.");
      }

      await requestToJoinOrganization(orgByCode.id, {
        uid: user.uid,
        email: user.email || email,
        displayName: user.displayName || userProfile?.displayName,
        firstName: userProfile?.firstName,
        lastName: userProfile?.lastName
      });

      setSuccessMsg(`Votre demande d'accès à l'association a bien été transmise à son administrateur.`);
      setInviteCodeInput('');
      await fetchStatus();
    } catch (err: any) {
      console.error("Join request failed:", err);
      setErrorMsg(err.message || "Erreur lors de la validation du code.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-between p-4 sm:p-6">
      {/* Top Bar */}
      <div className="w-full max-w-4xl flex justify-between items-center py-2">
        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <span className="text-blue-500">Asso</span>Compta AI
        </h1>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg border border-slate-800 transition-colors"
        >
          <LogOut size={14} />
          Se déconnecter
        </button>
      </div>

      {/* Main Card */}
      <div className="w-full max-w-xl my-auto">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-amber-500 to-emerald-500" />

          {/* Account status badge */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs bg-slate-950/80 border border-slate-800 rounded-xl p-3 mb-6">
            <span className="text-slate-400 flex items-center gap-1.5">
              <Mail size={14} className="text-blue-400 shrink-0" />
              Compte : <strong className="text-slate-200 break-all">{email || "Non renseigné"}</strong>
            </span>
            <div className="flex items-center gap-2">
              {userProfile?.orgName && (
                <span className="bg-blue-950/60 text-blue-300 border border-blue-800/50 px-2 py-0.5 rounded text-[11px] font-medium">
                  {userProfile.orgName}
                </span>
              )}
              <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded text-[11px]">
                Enregistré
              </span>
            </div>
          </div>

          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-blue-950/40 border border-blue-800/60 rounded-2xl flex items-center justify-center mx-auto mb-4 text-blue-400 shadow-inner">
              <ShieldAlert size={32} />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">Compte en attente d'accès</h2>
            <p className="text-slate-300 text-sm leading-relaxed">
              Votre compte est bien créé{userProfile?.orgName ? <> et rattaché à <strong>{userProfile.orgName}</strong></> : ''}.
              Dès que l'administrateur vous a attribué un rôle (Caissier, Vérificateur ou Lecteur) dans le panneau d'administration, cliquez sur <strong>« Vérifier mes accès »</strong> ci-dessous pour entrer.
            </p>
          </div>

          <div className="mb-6">
            <button
              type="button"
              onClick={onRefresh || fetchStatus}
              disabled={isRefreshing || loadingInfo}
              className="w-full py-3 px-5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2.5 transition-all shadow-lg shadow-blue-900/30 cursor-pointer"
            >
              <RefreshCw size={18} className={(isRefreshing || loadingInfo) ? "animate-spin" : ""} />
              {isRefreshing ? "Vérification en cours..." : "Vérifier mes accès (Entrer dans l'application)"}
            </button>
            <p className="text-[11px] text-slate-500 text-center mt-2">
              Vérification automatique toutes les 6 secondes…
            </p>
          </div>

          {pendingRequests.length > 0 && (
            <div className="space-y-2 mb-6">
              {pendingRequests.map((req) => (
                <div key={req.inviteId} className="flex items-center justify-between p-3 bg-slate-950 rounded-lg border border-amber-900/40 text-left">
                  <div className="flex items-center gap-3">
                    <Building2 className="text-amber-400" size={18} />
                    <div>
                      <h4 className="font-semibold text-white text-xs">{req.orgName}</h4>
                      <span className="text-[11px] text-slate-500">
                        Demandé le {new Date(req.requestedAt).toLocaleDateString('fr-CH')}
                      </span>
                    </div>
                  </div>
                  <span className="text-[10px] font-semibold text-amber-400 bg-amber-950/50 border border-amber-800/60 px-2 py-0.5 rounded">
                    En attente
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Optionnel : Code d'invitation */}
          <div className="border-t border-slate-800/80 pt-4 mb-4">
            <button
              type="button"
              onClick={() => setShowCodeInput(!showCodeInput)}
              className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-300 py-1 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Key size={13} className="text-slate-500" />
                Vous avez reçu un code d'invitation spécifique ? (Optionnel)
              </span>
              {showCodeInput ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>

            {showCodeInput && (
              <form onSubmit={handleSendJoinRequest} className="space-y-3 mt-3 pt-2">
                {successMsg && (
                  <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-lg text-emerald-300 text-xs">
                    {successMsg}
                  </div>
                )}

                {errorMsg && (
                  <div className="p-3 bg-rose-950/40 border border-rose-800/60 rounded-lg text-rose-300 text-xs">
                    {errorMsg}
                  </div>
                )}

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={inviteCodeInput}
                    onChange={(e) => setInviteCodeInput(e.target.value)}
                    placeholder="Code (ex: a1b2c3d4)"
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                    required
                  />
                  <button
                    type="submit"
                    disabled={submitting || !inviteCodeInput.trim()}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-lg font-medium text-xs flex items-center gap-1.5 transition-colors"
                  >
                    <Send size={13} />
                    {submitting ? "..." : "Valider"}
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="border-t border-slate-800 pt-4 flex justify-between items-center text-xs text-slate-500">
            <span>AssoCompta AI</span>
            <button
              onClick={handleLogout}
              className="text-rose-400 hover:text-rose-300 transition-colors"
            >
              Se déconnecter
            </button>
          </div>
        </div>
      </div>

      <div className="text-center text-xs text-slate-600">
        Sécurisé par Firebase Authentication & Firestore
      </div>
    </div>
  );
};
