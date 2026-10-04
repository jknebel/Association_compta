import React, { useState, useEffect } from 'react';
import { ShieldAlert, LogOut, RefreshCw, Mail, HelpCircle, CheckCircle2, Building2, Send, Clock, Key, Plus } from 'lucide-react';
import { logout } from '../services/authService';
import { useAuthContext } from '../contexts/AppContext';
import { 
  listAllOrganizations, 
  getUserPendingInvitations, 
  requestToJoinOrganization, 
  getOrganizationByInviteCode 
} from '../services/organizationService';
import { Organization } from '../types/rbac';
import { CreateOrgModal } from './CreateOrgModal';

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
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [pendingRequests, setPendingRequests] = useState<Array<{ orgId: string; orgName: string; inviteId: string; requestedAt: number }>>([]);
  const [loadingInfo, setLoadingInfo] = useState(true);
  
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');
  const [inviteCodeInput, setInviteCodeInput] = useState<string>('');
  const [useInviteCode, setUseInviteCode] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showCreateOrgModal, setShowCreateOrgModal] = useState<boolean>(false);

  const fetchStatus = async () => {
    if (!email) return;
    setLoadingInfo(true);
    try {
      const [allOrgs, pending] = await Promise.all([
        listAllOrganizations(),
        getUserPendingInvitations(email)
      ]);
      setOrganizations(allOrgs);
      setPendingRequests(pending);
      if (allOrgs.length > 0 && !selectedOrgId) {
        setSelectedOrgId(allOrgs[0].id);
      }
    } catch (e) {
      console.error("Error loading unauthorized info:", e);
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
      let targetOrgId = selectedOrgId;

      if (useInviteCode) {
        if (!inviteCodeInput.trim()) {
          throw new Error("Veuillez saisir un code d'invitation.");
        }
        const orgByCode = await getOrganizationByInviteCode(inviteCodeInput.trim());
        if (!orgByCode) {
          throw new Error("Code d'invitation invalide ou expiré.");
        }
        targetOrgId = orgByCode.id;
      }

      if (!targetOrgId) {
        throw new Error("Veuillez sélectionner une association.");
      }

      await requestToJoinOrganization(targetOrgId, {
        uid: user.uid,
        email: user.email || email,
        displayName: user.displayName || userProfile?.displayName,
        firstName: userProfile?.firstName,
        lastName: userProfile?.lastName
      });

      setSuccessMsg("Votre demande d'adhésion a été transmise à l'administrateur de l'association.");
      setInviteCodeInput('');
      await fetchStatus();
    } catch (err: any) {
      console.error("Join request failed:", err);
      setErrorMsg(err.message || "Erreur lors de l'envoi de la demande.");
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
            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-800 text-slate-300 border border-slate-700">
              Connecté
            </span>
          </div>

          {/* PENDING REQUESTS IF ANY */}
          {pendingRequests.length > 0 ? (
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-amber-950/40 border border-amber-800/60 rounded-2xl flex items-center justify-center mx-auto mb-4 text-amber-400 shadow-inner">
                <Clock size={32} />
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">Demande en attente de validation</h2>
              <p className="text-slate-400 text-sm mb-6">
                Votre demande a bien été enregistrée. L'administrateur de l'association doit valider vos accès et vous assigner vos unités.
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
                💡 Dès que l'administrateur aura validé votre compte, cliquez sur le bouton ci-dessous pour accéder directement à l'espace de votre association.
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
              {/* NO PENDING REQUEST -> CHOOSE ORG OR ENTER CODE */}
              <div className="text-center mb-6">
                <div className="w-16 h-16 bg-blue-950/40 border border-blue-800/60 rounded-2xl flex items-center justify-center mx-auto mb-4 text-blue-400 shadow-inner">
                  <Building2 size={32} />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Rejoindre une association</h2>
                <p className="text-slate-400 text-sm">
                  Pour commencer à utiliser l'outil, sélectionnez votre association pour transmettre votre demande à son administrateur.
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
                {!useInviteCode ? (
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                      Sélectionnez votre association :
                    </label>
                    {organizations.length === 0 ? (
                      <p className="text-xs text-slate-500 italic p-3 bg-slate-950 rounded-lg border border-slate-800">
                        Aucune association enregistrée pour l'instant. Demandez à votre Super Admin d'en créer une.
                      </p>
                    ) : (
                      <select
                        value={selectedOrgId}
                        onChange={(e) => setSelectedOrgId(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                        required
                      >
                        {organizations.map(org => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                      Code d'invitation :
                    </label>
                    <div className="relative">
                      <Key size={16} className="absolute left-3 top-3 text-slate-500" />
                      <input
                        type="text"
                        value={inviteCodeInput}
                        onChange={(e) => setInviteCodeInput(e.target.value)}
                        placeholder="Ex: a1b2c3d4"
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                        required={useInviteCode}
                      />
                    </div>
                  </div>
                )}

                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => { setUseInviteCode(!useInviteCode); setErrorMsg(null); }}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    {useInviteCode ? "Choisir dans la liste des associations" : "J'ai un code d'invitation privé"}
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={submitting || (!useInviteCode && organizations.length === 0)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-all shadow-lg shadow-blue-900/30"
                >
                  <Send size={16} />
                  {submitting ? "Envoi de la demande..." : "Envoyer ma demande d'accès"}
                </button>
              </form>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-800" /></div>
                <div className="relative flex justify-center text-xs uppercase"><span className="bg-slate-900 px-2 text-slate-500">ou</span></div>
              </div>

              <button
                type="button"
                onClick={() => setShowCreateOrgModal(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg font-medium text-xs transition-colors cursor-pointer"
              >
                <Plus size={14} className="text-blue-400" />
                Créer ma propre organisation (Association)
              </button>
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
        AssoCompta AI &bull; Système multi-association & gestion des unités
      </div>

      <CreateOrgModal 
        isOpen={showCreateOrgModal} 
        onClose={() => setShowCreateOrgModal(false)} 
        onSuccess={() => {
          if (onRefresh) onRefresh();
          else window.location.reload();
        }} 
      />
    </div>
  );
};
