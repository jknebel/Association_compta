import React, { useState, useEffect } from 'react';
import { useAuthContext, useOrgContext } from '../contexts/AppContext';
import { 
    createComptabilite, 
    listComptabilites, 
    deleteComptabilite,
    generateInviteLink,
    listInvitations,
    approveInvitation,
    approveInvitationWithAccess,
    rejectInvitation,
    setMemberComptaAccess,
    listOrganizationMembers,
    removeOrganizationMember
} from '../services/organizationService';
import { listAllRegisteredUsers } from '../services/userService';
import { Comptabilite, Invitation, OrgRole, ComptaRole, OrganizationMember } from '../types/rbac';
import { Settings, Users, Book, Link as LinkIcon, Plus, Trash2, Check, X, Loader2, UserPlus, Edit2, ShieldAlert, Eye, PenTool, CheckCircle, Search, UserCheck } from 'lucide-react';

export const AdminView: React.FC = () => {
    const { user, isSuperAdmin } = useAuthContext();
    const { selectedOrg, orgRole } = useOrgContext();

    const [activeTab, setActiveTab] = useState<'comptas' | 'members'>('comptas');
    const [comptas, setComptas] = useState<Comptabilite[]>([]);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [members, setMembers] = useState<OrganizationMember[]>([]);
    const [registeredUsers, setRegisteredUsers] = useState<Array<{ uid: string; email: string; displayName: string }>>([]);
    const [selectedFirebaseUserUid, setSelectedFirebaseUserUid] = useState<string>('');
    const [loading, setLoading] = useState(false);

    // Form state pour nouvelle compta
    const [newComptaName, setNewComptaName] = useState('');
    const [newComptaDesc, setNewComptaDesc] = useState('');

    // Form state pour affectation membre par email
    const [memberEmail, setMemberEmail] = useState('');
    const [memberName, setMemberName] = useState('');
    const [memberOrgRole, setMemberOrgRole] = useState<OrgRole>(OrgRole.MEMBER);
    const [memberComptaRoles, setMemberComptaRoles] = useState<Record<string, ComptaRole>>({});
    const [isSavingMember, setIsSavingMember] = useState(false);

    // Modal d'approbation d'invitation avec rôles
    const [approvingInvite, setApprovingInvite] = useState<Invitation | null>(null);
    const [approvingComptaRoles, setApprovingComptaRoles] = useState<Record<string, ComptaRole>>({});
    const [isApproving, setIsApproving] = useState(false);
    
    useEffect(() => {
        if (selectedOrg && (orgRole === OrgRole.ADMIN || isSuperAdmin)) {
            fetchData();
        }
    }, [selectedOrg, orgRole, isSuperAdmin]);

    const fetchData = async () => {
        if (!selectedOrg) return;
        setLoading(true);
        try {
            const [cList, iList, mList, uList] = await Promise.all([
                listComptabilites(selectedOrg.id),
                listInvitations(selectedOrg.id),
                listOrganizationMembers(selectedOrg.id),
                listAllRegisteredUsers()
            ]);
            setComptas(cList);
            setInvitations(iList);
            setMembers(mList);
            setRegisteredUsers(uList);
        } catch (e) {
            console.error("Fetch admin data error", e);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateCompta = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedOrg || !user || !newComptaName) return;
        
        try {
            await createComptabilite(selectedOrg.id, {
                name: newComptaName,
                description: newComptaDesc,
                createdBy: user.uid,
                currency: 'CHF',
                fiscalYearStart: '2026-01-01',
                fiscalYearEnd: '2026-12-31'
            });
            setNewComptaName('');
            setNewComptaDesc('');
            await fetchData();
        } catch (e) {
            console.error(e);
            alert("Erreur création comptabilité");
        }
    };

    const handleDeleteCompta = async (comptaId: string) => {
        if (!selectedOrg || !window.confirm("Supprimer cette comptabilité et TOUTES ses données ?")) return;
        try {
            await deleteComptabilite(selectedOrg.id, comptaId);
            await fetchData();
        } catch (e) {
            console.error(e);
        }
    };

    const handleSaveMemberAccess = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedOrg || !memberEmail.trim()) return;

        setIsSavingMember(true);
        try {
            await setMemberComptaAccess(
                selectedOrg.id,
                memberEmail.trim(),
                memberComptaRoles,
                memberOrgRole,
                memberName.trim() || undefined
            );
            setMemberEmail('');
            setMemberName('');
            setMemberOrgRole(OrgRole.MEMBER);
            setSelectedFirebaseUserUid('');
            setMemberComptaRoles({});
            await fetchData();
            alert("Permissions du membre enregistrées avec succès !");
        } catch (error) {
            console.error("Failed to save member access:", error);
            alert("Erreur lors de l'enregistrement des accès.");
        } finally {
            setIsSavingMember(false);
        }
    };

    const handleEditMember = (m: OrganizationMember) => {
        setMemberEmail(m.email);
        setMemberName(m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim());
        setMemberOrgRole(m.role || OrgRole.MEMBER);
        setMemberComptaRoles(m.comptaAccess || {});
        const matched = registeredUsers.find(u => u.email.toLowerCase() === m.email.toLowerCase());
        if (matched) {
            setSelectedFirebaseUserUid(matched.uid);
        } else {
            setSelectedFirebaseUserUid('');
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleRemoveMember = async (memberId: string) => {
        if (!selectedOrg || !window.confirm("Retirer ce membre de l'organisation et révoquer tous ses accès ?")) return;
        try {
            await removeOrganizationMember(selectedOrg.id, memberId);
            await fetchData();
        } catch (e) {
            console.error("Failed to remove member:", e);
            alert("Erreur lors de la suppression du membre.");
        }
    };

    const handleGenerateLink = async () => {
        if (!selectedOrg) return;
        try {
            const newCode = await generateInviteLink(selectedOrg.id);
            const link = `${window.location.origin}/?org=${selectedOrg.id}&code=${newCode}`;
            navigator.clipboard.writeText(link);
            alert("Lien d'invitation généré et copié dans le presse-papier !");
        } catch (e) {
            console.error(e);
        }
    };

    const handleStartApproval = (inv: Invitation) => {
        setApprovingInvite(inv);
        // Pré-remplir les comptabilités avec viewer par défaut ou vide
        setApprovingComptaRoles({});
    };

    const handleConfirmApproval = async () => {
        if (!selectedOrg || !user || !approvingInvite) return;
        setIsApproving(true);
        try {
            await approveInvitationWithAccess(selectedOrg.id, approvingInvite.id, user.uid, approvingComptaRoles);
            setApprovingInvite(null);
            setApprovingComptaRoles({});
            await fetchData();
            alert("Membre approuvé et accès configurés avec succès !");
        } catch (e) {
            console.error("Approval error", e);
            alert("Erreur lors de l'approbation.");
        } finally {
            setIsApproving(false);
        }
    };

    const handleReject = async (inviteId: string) => {
        if (!selectedOrg || !user) return;
        if (!window.confirm("Refuser cette demande d'adhésion ?")) return;
        try {
            await rejectInvitation(selectedOrg.id, inviteId, user.uid);
            await fetchData();
        } catch (e) {
            console.error(e);
        }
    };

    if (!selectedOrg || (orgRole !== OrgRole.ADMIN && !isSuperAdmin)) {
        return <div className="p-8 text-center text-red-500">Accès refusé. Administrateurs uniquement.</div>;
    }

    return (
        <div className="p-8 max-w-5xl mx-auto">
            <header className="mb-8">
                <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
                    <Settings className="text-blue-500" size={28} />
                    Administration: {selectedOrg.name}
                </h2>
                <p className="text-slate-400 text-sm mt-1">Gérez les espaces comptables et les permissions de vos collaborateurs.</p>
            </header>

            <div className="flex gap-4 border-b border-slate-800 mb-6">
                <button 
                    onClick={() => setActiveTab('comptas')}
                    className={`px-4 py-2 font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'comptas' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    <Book size={16} />
                    Comptabilités / Catégories ({comptas.length})
                </button>
                <button 
                    onClick={() => setActiveTab('members')}
                    className={`px-4 py-2 font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'members' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    <Users size={16} />
                    Membres & Rôles ({members.length})
                    {invitations.length > 0 && <span className="bg-amber-600 text-white text-xs px-2 py-0.5 rounded-full">{invitations.length} en attente</span>}
                </button>
            </div>

            {loading ? (
                <div className="flex justify-center p-12 text-slate-500"><Loader2 className="animate-spin" size={32} /></div>
            ) : activeTab === 'comptas' ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-1 bg-slate-900 border border-slate-800 p-6 rounded-xl h-fit">
                        <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
                            <Plus size={18} className="text-blue-500" />
                            Nouvelle Comptabilité
                        </h3>
                        <form onSubmit={handleCreateCompta} className="space-y-4">
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Nom (ex: Mandisé, Groupe 25/26)</label>
                                <input 
                                    type="text" 
                                    placeholder="Ex: Mandisé" 
                                    value={newComptaName} 
                                    onChange={e => setNewComptaName(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500" 
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Description (optionnelle)</label>
                                <textarea 
                                    placeholder="Description de la section..." 
                                    value={newComptaDesc} 
                                    onChange={e => setNewComptaDesc(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500 min-h-[80px]"
                                />
                            </div>
                            <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-500 flex justify-center items-center gap-2 text-sm font-semibold transition-colors">
                                <Plus size={16} /> Créer la comptabilité
                            </button>
                        </form>
                    </div>
                    <div className="md:col-span-2 space-y-4">
                        {comptas.length === 0 ? (
                            <div className="p-12 text-center text-slate-500 italic bg-slate-900 border border-slate-800 rounded-xl">
                                Aucune comptabilité pour le moment.
                            </div>
                        ) : (
                            comptas.map(c => (
                                <div key={c.id} className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex justify-between items-center hover:border-slate-700 transition-colors">
                                    <div className="flex items-start gap-3">
                                        <div className="p-2 bg-blue-900/30 text-blue-400 rounded-lg border border-blue-800/40 mt-0.5">
                                            <Book size={18} />
                                        </div>
                                        <div>
                                            <h4 className="font-bold text-white text-base">{c.name}</h4>
                                            <p className="text-slate-400 text-xs mt-0.5">{c.description || "Aucune description"}</p>
                                            <p className="text-slate-600 font-mono text-[10px] mt-1">ID: {c.id}</p>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => handleDeleteCompta(c.id)} 
                                        className="text-slate-500 hover:text-red-400 hover:bg-red-900/20 p-2 rounded-lg transition-colors"
                                        title="Supprimer la comptabilité"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            ) : (
                <div className="space-y-8">
                    {/* Formulaire d'affectation */}
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl shadow-sm">
                        <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
                            <UserPlus size={18} className="text-emerald-500" />
                            Assigner / Mettre à jour un Membre
                        </h3>
                        <p className="text-sm text-slate-400 mb-6">
                            Sélectionnez un utilisateur inscrit sur Firebase et configurez ses droits par unité comptable (<strong>Caissier</strong>, <strong>Vérificateur</strong> ou <strong>Lecteur</strong>).
                        </p>

                        <form onSubmit={handleSaveMemberAccess} className="space-y-6">
                            {/* Sélecteur des utilisateurs inscrits sur Firebase */}
                            <div className="p-4 bg-slate-950 rounded-xl border border-slate-800">
                                <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center justify-between">
                                    <span className="flex items-center gap-1.5">
                                        <UserCheck size={14} className="text-emerald-400" />
                                        Choisir parmi les utilisateurs inscrits sur Firebase :
                                    </span>
                                    <span className="text-slate-500 font-normal">({registeredUsers.length} comptes trouvés)</span>
                                </label>
                                <select
                                    value={selectedFirebaseUserUid}
                                    onChange={(e) => {
                                        const uid = e.target.value;
                                        setSelectedFirebaseUserUid(uid);
                                        const found = registeredUsers.find(u => u.uid === uid);
                                        if (found) {
                                            setMemberEmail(found.email);
                                            setMemberName(found.displayName);
                                            const existing = members.find(m => m.email.toLowerCase() === found.email.toLowerCase());
                                            if (existing) {
                                                setMemberOrgRole(existing.role || OrgRole.MEMBER);
                                                if (existing.comptaAccess) {
                                                    setMemberComptaRoles(existing.comptaAccess);
                                                } else {
                                                    setMemberComptaRoles({});
                                                }
                                            } else {
                                                setMemberComptaRoles({});
                                            }
                                        }
                                    }}
                                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                                >
                                    <option value="">-- Sélectionner un utilisateur inscrit sur Firebase --</option>
                                    {registeredUsers.map(u => (
                                        <option key={u.uid} value={u.uid}>
                                            {u.displayName} ({u.email})
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div>
                                    <label className="block text-xs font-semibold text-slate-400 mb-1">Email du membre *</label>
                                    <input 
                                        type="email" 
                                        value={memberEmail} 
                                        onChange={e => setMemberEmail(e.target.value)}
                                        placeholder="collaborateur@organisation.ch" 
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500" 
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-slate-400 mb-1">Nom / Prénom (optionnel)</label>
                                    <input 
                                        type="text" 
                                        value={memberName} 
                                        onChange={e => setMemberName(e.target.value)}
                                        placeholder="Ex: Jean Dupont" 
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500" 
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-slate-400 mb-1">Statut dans l'organisation</label>
                                    <select
                                        value={memberOrgRole}
                                        onChange={e => setMemberOrgRole(e.target.value as OrgRole)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                                    >
                                        <option value={OrgRole.MEMBER}>Membre de l'organisation</option>
                                        <option value={OrgRole.ADMIN}>Administrateur de l'organisation</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3">
                                    Droits par Comptabilité / Catégorie
                                </label>
                                {comptas.length === 0 ? (
                                    <p className="text-sm text-slate-500 italic">Veuillez d'abord créer au moins une comptabilité dans l'onglet précédent.</p>
                                ) : (
                                    <div className="space-y-2">
                                        {comptas.map(c => {
                                            const currentRole = memberComptaRoles[c.id] || 'none';
                                            return (
                                                <div key={c.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 bg-slate-950 rounded-lg border border-slate-800 gap-3">
                                                    <div>
                                                        <span className="text-white text-sm font-semibold">{c.name}</span>
                                                        {c.description && <span className="text-slate-500 text-xs block">{c.description}</span>}
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <select
                                                            value={currentRole}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                setMemberComptaRoles(prev => {
                                                                    const copy = { ...prev };
                                                                    if (val === 'none') {
                                                                        delete copy[c.id];
                                                                    } else {
                                                                        copy[c.id] = val as ComptaRole;
                                                                    }
                                                                    return copy;
                                                                });
                                                            }}
                                                            className={`text-xs rounded-lg px-3 py-1.5 font-medium border focus:outline-none transition-colors ${
                                                                (currentRole === 'caissier' || currentRole === 'comptable')
                                                                    ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300' 
                                                                    : currentRole === 'verificateur'
                                                                    ? 'bg-amber-950/60 border-amber-700 text-amber-300'
                                                                    : currentRole === 'viewer' 
                                                                    ? 'bg-blue-950/60 border-blue-700 text-blue-300'
                                                                    : 'bg-slate-900 border-slate-700 text-slate-400'
                                                            }`}
                                                        >
                                                            <option value="none">Aucun accès</option>
                                                            <option value="caissier">💼 Caissier (Accès complet & validation)</option>
                                                            <option value="verificateur">🔍 Vérificateur (Affectation du compte & notes)</option>
                                                            <option value="viewer">👁️ Lecteur (Consultation seule)</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <button
                                type="submit"
                                disabled={isSavingMember || !memberEmail.trim()}
                                className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                                {isSavingMember ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                                Enregistrer les permissions
                            </button>
                        </form>
                    </div>

                    {/* Liste des membres actuels */}
                    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                        <div className="p-4 border-b border-slate-800 bg-slate-950 flex justify-between items-center">
                            <h3 className="font-semibold text-white flex items-center gap-2">
                                <Users size={18} className="text-blue-500" />
                                Membres de l'Organisation ({members.length})
                            </h3>
                        </div>

                        {members.length === 0 ? (
                            <div className="p-8 text-center text-slate-500 italic">Aucun membre enregistré pour le moment.</div>
                        ) : (
                            <div className="divide-y divide-slate-800">
                                {members.map(m => {
                                    const isAdmin = m.role === OrgRole.ADMIN;
                                    const accessEntries = Object.entries(m.comptaAccess || {});
                                    return (
                                        <div key={m.id || m.email} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-800/40 transition-colors">
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <h4 className="font-semibold text-slate-200 text-sm">
                                                        {m.displayName || m.email}
                                                    </h4>
                                                    {isAdmin && (
                                                        <span className="text-[10px] font-bold uppercase tracking-wider bg-purple-900/40 border border-purple-800 text-purple-300 px-2 py-0.5 rounded">
                                                            Admin Organisation
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-slate-400 text-xs mt-0.5">{m.email}</p>
                                                
                                                {/* Badges d'accès par comptabilité */}
                                                <div className="mt-2 flex flex-wrap gap-1.5">
                                                    {isAdmin ? (
                                                        <span className="text-xs bg-purple-950/60 border border-purple-800/60 text-purple-300 px-2 py-0.5 rounded flex items-center gap-1">
                                                            Accès Admin à toutes les unités
                                                        </span>
                                                    ) : accessEntries.length === 0 ? (
                                                        <span className="text-xs text-slate-500 italic">Aucune unité assignée</span>
                                                    ) : (
                                                        accessEntries.map(([cId, r]) => {
                                                            const comptaObj = comptas.find(c => c.id === cId);
                                                            const cName = comptaObj ? comptaObj.name : cId;
                                                            const isCaissier = r === 'caissier' || r === 'comptable';
                                                            const isVerif = r === 'verificateur';
                                                            return (
                                                                <span 
                                                                    key={cId} 
                                                                    className={`text-xs px-2 py-0.5 rounded border flex items-center gap-1 ${
                                                                        isCaissier 
                                                                            ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-300' 
                                                                            : isVerif
                                                                            ? 'bg-amber-950/50 border-amber-800/60 text-amber-300'
                                                                            : 'bg-blue-950/50 border-blue-800/60 text-blue-300'
                                                                    }`}
                                                                >
                                                                    {isCaissier ? <PenTool size={10} /> : isVerif ? <Search size={10} /> : <Eye size={10} />}
                                                                    <strong className="font-semibold">{cName}:</strong>
                                                                    <span>{isCaissier ? 'Caissier' : isVerif ? 'Vérificateur' : 'Lecteur'}</span>
                                                                </span>
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                                                {!isAdmin && (
                                                    <>
                                                        <button 
                                                            onClick={() => handleEditMember(m)}
                                                            className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-800 rounded transition-colors"
                                                            title="Modifier les accès"
                                                        >
                                                            <Edit2 size={16} />
                                                        </button>
                                                        <button 
                                                            onClick={() => m.id && handleRemoveMember(m.id)}
                                                            className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition-colors"
                                                            title="Retirer le membre"
                                                        >
                                                            <Trash2 size={16} />
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Section lien d'invitation générique & demandes */}
                    <div className="pt-4 border-t border-slate-800/80 space-y-4">
                        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
                            <div>
                                <h4 className="font-medium text-slate-200 text-sm">Lien d'invitation public de l'association</h4>
                                <p className="text-slate-500 text-xs">Permet aux membres de s'inscrire directement avec rattachement automatique à votre association.</p>
                            </div>
                            <button onClick={handleGenerateLink} className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2 border border-slate-700 transition-colors">
                                <LinkIcon size={14} />
                                Copier le lien d'invitation
                            </button>
                        </div>

                        {invitations.length > 0 && (
                            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                                <div className="p-3 bg-slate-950 border-b border-slate-800">
                                    <h4 className="font-semibold text-white text-xs uppercase tracking-wider">Demandes en attente de validation ({invitations.length})</h4>
                                </div>
                                <div className="divide-y divide-slate-800">
                                    {invitations.map(inv => (
                                        <div key={inv.id} className="p-3 flex items-center justify-between text-sm">
                                            <div>
                                                <p className="font-medium text-slate-200">{inv.firstName} {inv.lastName}</p>
                                                <p className="text-slate-400 text-xs">{inv.email}</p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button 
                                                    onClick={() => handleStartApproval(inv)} 
                                                    className="bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 px-3 py-1.5 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors"
                                                >
                                                    <Check size={14} />
                                                    Valider & Assigner les unités
                                                </button>
                                                <button 
                                                    onClick={() => handleReject(inv.id)} 
                                                    className="bg-red-600/20 text-red-400 hover:bg-red-600/40 p-1.5 rounded transition-colors"
                                                    title="Refuser la demande"
                                                >
                                                    <X size={16} />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* MODAL D'APPROBATION D'INVITATION AVEC ASSIGNATION DES ROLES */}
                    {approvingInvite && (
                        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                            <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-2xl animate-in fade-in zoom-in-95">
                                <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-800">
                                    <div>
                                        <h3 className="font-bold text-white text-base">Valider l'adhésion</h3>
                                        <p className="text-xs text-slate-400">
                                            {approvingInvite.firstName} {approvingInvite.lastName} ({approvingInvite.email})
                                        </p>
                                    </div>
                                    <button onClick={() => setApprovingInvite(null)} className="text-slate-500 hover:text-white">
                                        <X size={18} />
                                    </button>
                                </div>

                                <div className="space-y-4 mb-6">
                                    <p className="text-xs text-slate-300">
                                        Choisissez les unités (comptabilités) et les droits attribués à ce membre :
                                    </p>

                                    {comptas.length === 0 ? (
                                        <p className="text-xs text-slate-500 italic">Aucune unité créée pour le moment.</p>
                                    ) : (
                                        <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                                            {comptas.map(c => {
                                                const r = approvingComptaRoles[c.id] || 'none';
                                                return (
                                                    <div key={c.id} className="flex items-center justify-between p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-xs">
                                                        <span className="font-medium text-slate-200">{c.name}</span>
                                                        <select
                                                            value={r}
                                                            onChange={(e) => {
                                                                const val = e.target.value;
                                                                setApprovingComptaRoles(prev => {
                                                                    const copy = { ...prev };
                                                                    if (val === 'none') delete copy[c.id];
                                                                    else copy[c.id] = val as ComptaRole;
                                                                    return copy;
                                                                });
                                                            }}
                                                            className={`text-xs rounded px-2.5 py-1 font-medium border focus:outline-none ${
                                                                (r === 'caissier' || r === 'comptable')
                                                                    ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300' 
                                                                    : r === 'verificateur'
                                                                    ? 'bg-amber-950/60 border-amber-700 text-amber-300'
                                                                    : r === 'viewer'
                                                                    ? 'bg-blue-950/60 border-blue-700 text-blue-300'
                                                                    : 'bg-slate-900 border-slate-700 text-slate-400'
                                                            }`}
                                                        >
                                                            <option value="none">Aucun accès</option>
                                                            <option value="caissier">💼 Caissier</option>
                                                            <option value="verificateur">🔍 Vérificateur</option>
                                                            <option value="viewer">👁️ Lecteur</option>
                                                        </select>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                <div className="flex justify-end gap-2">
                                    <button 
                                        onClick={() => setApprovingInvite(null)}
                                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition-colors"
                                    >
                                        Annuler
                                    </button>
                                    <button 
                                        onClick={handleConfirmApproval}
                                        disabled={isApproving}
                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-lg shadow-emerald-900/20"
                                    >
                                        {isApproving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                                        Confirmer et accorder les accès
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
