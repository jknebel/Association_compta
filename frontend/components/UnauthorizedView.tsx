import React, { useState, useEffect } from 'react';
import { ShieldAlert, LogOut, RefreshCw, Mail, Building2, Send, Clock, Key } from 'lucide-react';
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
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-between p-6">
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
        <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-amber-500 to-emerald-500" />

          {/* Account status badge */}
          <div className="flex items-center justify-between text-xs bg-slate-950/80 border border-slate-800 rounded-xl p-3 mb-6">
            <span className="text-slate-400 flex items-center gap-1.5">
              <Mail size={14} className="text-blue-400" />
              Compte : <strong className="text-slate-200">{email || "Non renseigné"}</strong>
            </span>
            <span className="bg-slate-800 text-slate-400 px-2 py-0.5 rounded text-[11px]">
              Enregistré
            </span>
          </div>

          {pendingRequests.length > 0 ? (
            <div className="text-center">
              <div className="w-16 h-16 bg-amber-950/40 border border-amber-800/60 rounded-2xl flex items-center justify-center mx-auto mb-4 text-amber-400 shadow-inner">
                <Clock size={32} />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Demande en attente de validation</h2>
              <p className="text-slate-400 text-sm mb-6">
                Votre demande a bien été transmise. L'administrateur de votre association doit valider vos accès et vous assigner vos unités.
              </p>

              <div className="space-y-3 mb-6">
                {pendingRequests.map((req) => (
                  <div key={req.inviteId} className="flex items-center justify-between p-3.5 bg-slate-950 rounded-lg border border-amber-900/40 text-left">
                    <div className="flex items-center gap-3">
                      <Building2 className="text-amber-400" size={20} />
                      <div>
                        <h4 className="font-semibold text-white text-sm">{req.orgName}</h4>
                        <span className="text-xs text-slate-500">
                          Demandé le {new Date(req.requestedAt).toLocaleDateString('fr-CH')}
                        </span>
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold text-amber-400 bg-amber-950/50 border border-amber-800/60 px-2 py-0.5 rounded">
                      En attente
                    </span>
                  </div>
                ))}
              </div>

              <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800 text-xs text-slate-400 mb-6">
                💡 Dès que l'administrateur aura activé votre compte, cliquez sur le bouton ci-dessous pour accéder directement à votre espace.
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={onRefresh || fetchStatus}
                  disabled={isRefreshing || loadingInfo}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-all shadow-lg shadow-blue-900/30"
                >
                  <RefreshCw size={16} className={(isRefreshing || loadingInfo) ? "animate-spin" : ""} />
                  {isRefreshing ? "Vérification..." : "Vérifier si validé"}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-blue-950/40 border border-blue-800/60 rounded-2xl flex items-center justify-center mx-auto mb-4 text-blue-400 shadow-inner">
                  <ShieldAlert size={32} />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Compte en attente d'accès</h2>
                <p className="text-slate-400 text-sm">
                  Votre compte est bien créé sur la plateforme. Pour rejoindre votre espace, contactez l'administrateur de votre association ou saisissez votre code d'invitation privé.
                </p>
              </div>

              {successMsg && (
                <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-lg text-emerald-300 text-xs mb-4">
                  {successMsg}
                </div>
              )}

              {errorMsg && (
                <div className="p-3 bg-rose-950/40 border border-rose-800/60 rounded-lg text-rose-300 text-xs mb-4">
                  {errorMsg}
                </div>
              )}

              <form onSubmit={handleSendJoinRequest} className="space-y-4 mb-6">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                    Code d'invitation de votre association :
                  </label>
                  <div className="relative">
                    <Key size={16} className="absolute left-3 top-3 text-slate-500" />
                    <input
                      type="text"
                      value={inviteCodeInput}
                      onChange={(e) => setInviteCodeInput(e.target.value)}
                      placeholder="Ex: a1b2c3d4"
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                      required
                    />
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Ce code vous est transmis de manière confidentielle par l'administrateur de votre association.
                  </p>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={submitting || !inviteCodeInput.trim()}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-all shadow-lg shadow-blue-900/30"
                  >
                    <Send size={16} />
                    {submitting ? "Validation..." : "Valider mon code"}
                  </button>
                  <button
                    type="button"
                    onClick={onRefresh || fetchStatus}
                    disabled={isRefreshing || loadingInfo}
                    className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors border border-slate-700"
                    title="Actualiser pour vérifier si l'administrateur vous a déjà ajouté"
                  >
                    <RefreshCw size={14} className={(isRefreshing || loadingInfo) ? "animate-spin" : ""} />
                    Vérifier mes accès
                  </button>
                </div>
              </form>
            </div>
          )}

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
        AssoCompta AI &bull; Système confidentiel et étanche multi-associations
      </div>
    </div>
  );
};
