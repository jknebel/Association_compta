import React, { useState, useEffect } from 'react';
import { useAuthContext, useOrgContext, useComptaContext } from '../contexts/AppContext';
import {
    createComptabilite,
    listComptabilites,
    deleteComptabilite,
    renameComptabilite,
    generateInviteLink,
    listInvitations,
    approveInvitationWithAccess,
    rejectInvitation,
    setMemberComptaAccess,
    setSingleComptaMemberAccess,
    listOrganizationMembers,
    removeOrganizationMember
} from '../services/organizationService';
import { listAllRegisteredUsers } from '../services/userService';
import { Organization, Comptabilite, Invitation, OrgRole, ComptaRole, OrganizationMember } from '../types/rbac';
import {
    Users,
    Book,
    Link as LinkIcon,
    Plus,
    Trash2,
    Check,
    X,
    Loader2,
    UserPlus,
    Edit2,
    Eye,
    PenTool,
    Search,
    UserCheck,
    Shield,
    Copy
} from 'lucide-react';

interface AdminViewProps {
    orgOverride?: Organization | null;
    isOrgAdminOverride?: boolean;
    mode?: 'org' | 'compta';
    hideComptasTab?: boolean;
    onClose?: () => void;
    onChanged?: () => void;
}

export const AdminView: React.FC<AdminViewProps> = ({
    orgOverride,
    isOrgAdminOverride,
    mode,
    hideComptasTab = false,
    onClose,
    onChanged
}) => {
    const { user, isSuperAdmin } = useAuthContext();
    const { selectedOrg: contextOrg, orgRole } = useOrgContext();
    const { selectedCompta, setSelectedCompta, comptaRole } = useComptaContext();

    const activeOrg = orgOverride || contextOrg;
    const isOrgAdmin = Boolean(isSuperAdmin || isOrgAdminOverride || orgRole === OrgRole.ADMIN);
    const isComptaCaissier = Boolean(
        isOrgAdmin ||
        comptaRole === 'caissier' ||
        comptaRole === 'comptable' ||
        comptaRole === 'admin'
    );

    const effectiveMode: 'org' | 'compta' = mode || (selectedCompta ? 'compta' : 'org');

    const [activeTab, setActiveTab] = useState<'comptas' | 'members'>('members');
    const [comptas, setComptas] = useState<Comptabilite[]>([]);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [members, setMembers] = useState<OrganizationMember[]>([]);
    const [registeredUsers, setRegisteredUsers] = useState<Array<{ uid: string; email: string; displayName: string }>>([]);
    const [selectedFirebaseUserUid, setSelectedFirebaseUserUid] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [copiedLink, setCopiedLink] = useState(false);

    // Form state pour nouvelle compta
    const [newComptaName, setNewComptaName] = useState('');
    const [newComptaDesc, setNewComptaDesc] = useState('');

    // State pour renommer une compta
    const [editingComptaId, setEditingComptaId] = useState<string | null>(null);
    const [editComptaName, setEditComptaName] = useState('');
    const [editComptaDesc, setEditComptaDesc] = useState('');
    const [isSavingComptaRename, setIsSavingComptaRename] = useState(false);

    // Form state pour affectation membre
    const [memberEmail, setMemberEmail] = useState('');
    const [memberName, setMemberName] = useState('');
    const [memberOrgRole, setMemberOrgRole] = useState<OrgRole>(OrgRole.MEMBER);
    const [memberComptaRoles, setMemberComptaRoles] = useState<Record<string, ComptaRole>>({});
    const [singleComptaRole, setSingleComptaRole] = useState<ComptaRole | 'none'>(ComptaRole.VERIFICATEUR);
    const [isSavingMember, setIsSavingMember] = useState(false);

    // Modal d'approbation d'invitation avec rôles
    const [approvingInvite, setApprovingInvite] = useState<Invitation | null>(null);
    const [approvingComptaRoles, setApprovingComptaRoles] = useState<Record<string, ComptaRole>>({});
    const [isApproving, setIsApproving] = useState(false);

    useEffect(() => {
        if (activeOrg && (isOrgAdmin || isComptaCaissier)) {
            fetchData();
        }
    }, [activeOrg?.id, isOrgAdmin, isComptaCaissier, selectedCompta?.id]);

    const fetchData = async () => {
        if (!activeOrg) return;
        setLoading(true);
        try {
            const [cList, iList, mList, uList] = await Promise.all([
                listComptabilites(activeOrg.id),
                listInvitations(activeOrg.id),
                listOrganizationMembers(activeOrg.id),
                listAllRegisteredUsers(activeOrg.id, activeOrg.name)
            ]);
            setComptas(cList);
            setInvitations(iList);

            const combinedUsers = [...uList];
            for (const m of mList) {
                if (m.email && !combinedUsers.some(u => u.email.toLowerCase() === m.email.toLowerCase())) {
                    combinedUsers.push({
                        uid: m.uid || m.id || m.email,
                        email: m.email.toLowerCase(),
                        displayName: m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.email
                    });
                }
            }

            // S'assurer qu'il y a toujours au moins 1 administrateur dans l'organisation (jamais 0)
            const hasExplicitAdmin = mList.some(m => m.role === OrgRole.ADMIN && m.status !== 'rejected');
            if (!hasExplicitAdmin) {
                const fallbackAdminUser =
                    combinedUsers.find(
                        u =>
                            (activeOrg.adminEmail && u.email.toLowerCase() === activeOrg.adminEmail.trim().toLowerCase()) ||
                            (activeOrg.createdBy && u.uid === activeOrg.createdBy)
                    ) ||
                    (user?.email
                        ? {
                              uid: user.uid,
                              email: user.email.toLowerCase(),
                              displayName: user.displayName || user.email
                          }
                        : null);

                if (fallbackAdminUser) {
                    const existingEntry = mList.find(
                        m => m.email?.toLowerCase() === fallbackAdminUser.email.toLowerCase() || m.uid === fallbackAdminUser.uid
                    );
                    try {
                        await setMemberComptaAccess(
                            activeOrg.id,
                            fallbackAdminUser.email,
                            existingEntry?.comptaAccess || {},
                            OrgRole.ADMIN,
                            existingEntry?.displayName || fallbackAdminUser.displayName,
                            fallbackAdminUser.uid
                        );
                        if (existingEntry) {
                            existingEntry.role = OrgRole.ADMIN;
                        } else {
                            mList.push({
                                id: fallbackAdminUser.uid,
                                uid: fallbackAdminUser.uid,
                                email: fallbackAdminUser.email,
                                displayName: fallbackAdminUser.displayName,
                                role: OrgRole.ADMIN,
                                status: 'approved',
                                joinedAt: Date.now(),
                                comptaAccess: {}
                            });
                        }
                    } catch (seedErr) {
                        console.warn("Could not auto-seed initial admin:", seedErr);
                    }
                }
            }

            setMembers([...mList]);
            setRegisteredUsers(combinedUsers);
        } catch (e) {
            console.error("Fetch admin data error", e);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateCompta = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!activeOrg || !user || !newComptaName) return;

        try {
            await createComptabilite(activeOrg.id, {
                name: newComptaName,
                description: newComptaDesc,
                createdBy: user.uid,
                currency: 'CHF',
                fiscalYearStart: '2026-01-01',
                fiscalYearEnd: '2026-12-31'
            }, user.uid);
            setNewComptaName('');
            setNewComptaDesc('');
            await fetchData();
            onChanged?.();
        } catch (e) {
            console.error(e);
            alert("Erreur création comptabilité");
        }
    };

    const handleDeleteCompta = async (comptaId: string) => {
        if (!activeOrg || !window.confirm("Supprimer cette comptabilité et TOUTES ses données ?")) return;
        try {
            await deleteComptabilite(activeOrg.id, comptaId);
            await fetchData();
            onChanged?.();
        } catch (e) {
            console.error(e);
        }
    };

    const handleSaveRenameCompta = async (comptaId: string) => {
        if (!activeOrg || !editComptaName.trim()) return;
        setIsSavingComptaRename(true);
        try {
            const newName = editComptaName.trim();
            const newDesc = editComptaDesc.trim();
            await renameComptabilite(activeOrg.id, comptaId, newName, newDesc);
            setComptas(prev => prev.map(c => c.id === comptaId ? { ...c, name: newName, description: newDesc } : c));
            if (selectedCompta && selectedCompta.id === comptaId) {
                setSelectedCompta({ ...selectedCompta, name: newName, description: newDesc });
            }
            setEditingComptaId(null);
            onChanged?.();
        } catch (e) {
            console.error(e);
            alert("Erreur lors du renommage de la comptabilité.");
        } finally {
            setIsSavingComptaRename(false);
        }
    };

    const getUniqueAdminCount = (excludeEmail?: string, excludeUid?: string) => {
        const adminKeys = new Set<string>();
        const normExclude = excludeEmail?.trim().toLowerCase();
        for (const m of members) {
            if (m.role === OrgRole.ADMIN && m.status !== 'rejected') {
                const mEmail = (m.email || '').trim().toLowerCase();
                const mUid = m.uid || m.id || '';
                const isExcluded =
                    (normExclude && mEmail === normExclude) ||
                    (excludeUid && mUid === excludeUid);
                if (!isExcluded) {
                    adminKeys.add(mEmail || mUid);
                }
            }
        }
        return adminKeys.size;
    };

    const handleSaveMemberAccess = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!activeOrg || !memberEmail.trim()) return;

        const otherAdmins = getUniqueAdminCount(memberEmail, selectedFirebaseUserUid);
        const existingMember = members.find(
            m => m.email?.toLowerCase() === memberEmail.trim().toLowerCase() || (selectedFirebaseUserUid && m.uid === selectedFirebaseUserUid)
        );
        const wasAdmin = existingMember?.role === OrgRole.ADMIN;

        if (memberOrgRole === OrgRole.ADMIN) {
            if (otherAdmins >= 2) {
                alert("Limite atteinte : il ne peut y avoir que 2 administrateurs maximum par association pour éviter les conflits.");
                return;
            }
        } else if (wasAdmin && otherAdmins === 0) {
            alert("Action impossible : il doit toujours y avoir au moins 1 administrateur dans l'association (0 n'est pas possible). Nommez d'abord un second administrateur avant de retirer celui-ci.");
            return;
        }

        setIsSavingMember(true);
        try {
            await setMemberComptaAccess(
                activeOrg.id,
                memberEmail.trim(),
                memberComptaRoles,
                memberOrgRole,
                memberName.trim() || undefined,
                selectedFirebaseUserUid || undefined
            );
            setMemberEmail('');
            setMemberName('');
            setMemberOrgRole(OrgRole.MEMBER);
            setSelectedFirebaseUserUid('');
            setMemberComptaRoles({});
            await fetchData();
            onChanged?.();
            alert("Permissions du membre enregistrées avec succès !");
        } catch (error: any) {
            console.error("Failed to save member access:", error);
            alert(error?.message || "Erreur lors de l'enregistrement des accès.");
        } finally {
            setIsSavingMember(false);
        }
    };

    const handleSaveSingleComptaAccess = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!activeOrg || !selectedCompta || !memberEmail.trim()) return;

        setIsSavingMember(true);
        try {
            await setSingleComptaMemberAccess(
                activeOrg.id,
                selectedCompta.id,
                memberEmail.trim(),
                singleComptaRole,
                memberName.trim() || undefined,
                selectedFirebaseUserUid || undefined
            );
            setMemberEmail('');
            setMemberName('');
            setSelectedFirebaseUserUid('');
            setSingleComptaRole(ComptaRole.VERIFICATEUR);
            await fetchData();
            onChanged?.();
            alert(`Accès mis à jour pour la comptabilité "${selectedCompta.name}" !`);
        } catch (error) {
            console.error("Failed to save single compta member access:", error);
            alert("Erreur lors de l'enregistrement de l'accès.");
        } finally {
            setIsSavingMember(false);
        }
    };

    const handleQuickChangeSingleComptaRole = async (
        regUser: { uid: string; email: string; displayName: string },
        newRole: ComptaRole | 'none'
    ) => {
        if (!activeOrg || !selectedCompta) return;
        try {
            await setSingleComptaMemberAccess(
                activeOrg.id,
                selectedCompta.id,
                regUser.email,
                newRole,
                regUser.displayName,
                regUser.uid
            );
            await fetchData();
            onChanged?.();
        } catch (e) {
            console.error("Failed quick role change:", e);
            alert("Erreur lors de la modification du rôle.");
        }
    };

    const handleToggleOrgAdmin = async (
        regUser: { uid: string; email: string; displayName: string },
        existingMember?: OrganizationMember
    ) => {
        if (!activeOrg || !isOrgAdmin) {
            alert("Seul un administrateur du groupe peut donner ou retirer le rôle d'administrateur.");
            return;
        }
        const currentlyAdmin = existingMember?.role === OrgRole.ADMIN;
        const otherAdmins = getUniqueAdminCount(regUser.email, regUser.uid);

        if (currentlyAdmin && otherAdmins === 0) {
            alert("Action impossible (minimum 1 admin) : vous ne pouvez pas retirer le dernier administrateur du groupe. Nommez d'abord un second administrateur.");
            return;
        }
        if (!currentlyAdmin && otherAdmins >= 2) {
            alert("Limite atteinte (2/2) : il ne peut y avoir que 2 administrateurs maximum par association. Retirez d'abord un administrateur actuel si vous souhaitez le remplacer.");
            return;
        }
        const confirmMsg = currentlyAdmin
            ? `Retirer les droits d'Administrateur du groupe « ${activeOrg.name} » à ${regUser.displayName || regUser.email} ?`
            : `Donner les droits d'Administrateur du groupe « ${activeOrg.name} » à ${regUser.displayName || regUser.email} ?\n\nIl aura accès à toutes les comptabilités du groupe et pourra gérer les membres (1 à 2 admins par groupe).`;
        if (!window.confirm(confirmMsg)) return;

        setIsSavingMember(true);
        try {
            const nextRole = currentlyAdmin ? OrgRole.MEMBER : OrgRole.ADMIN;
            await setMemberComptaAccess(
                activeOrg.id,
                regUser.email,
                existingMember?.comptaAccess || {},
                nextRole,
                existingMember?.displayName || regUser.displayName,
                regUser.uid
            );
            await fetchData();
            onChanged?.();
        } catch (e: any) {
            console.error("Failed to toggle org admin:", e);
            alert(e?.message || "Erreur lors de la modification du rôle Administrateur.");
        } finally {
            setIsSavingMember(false);
        }
    };

    const handleEditMember = (m: OrganizationMember) => {
        setMemberEmail(m.email);
        setMemberName(m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim());
        setMemberOrgRole(m.role || OrgRole.MEMBER);
        setMemberComptaRoles(m.comptaAccess || {});
        if (selectedCompta) {
            const currentRole = m.comptaAccess?.[selectedCompta.id] || ComptaRole.VERIFICATEUR;
            setSingleComptaRole(currentRole as ComptaRole);
        }
        const matched = registeredUsers.find(u => u.email.toLowerCase() === m.email.toLowerCase());
        if (matched) {
            setSelectedFirebaseUserUid(matched.uid);
        } else {
            setSelectedFirebaseUserUid('');
        }
    };

    const handleGenerateLink = async () => {
        if (!activeOrg) return;
        try {
            const code = await generateInviteLink(activeOrg.id, false);
            const link = `${window.location.origin}/?org=${activeOrg.id}&code=${code}`;
            await navigator.clipboard.writeText(link);
            setCopiedLink(true);
            setTimeout(() => setCopiedLink(false), 3000);
        } catch (e) {
            console.error(e);
            alert("Erreur lors de la copie du lien d'inscription.");
        }
    };

    const handleRemoveMember = async (memberId: string) => {
        if (!activeOrg || !window.confirm("Retirer ce membre de l'organisation et révoquer tous ses accès ?")) return;
        try {
            await removeOrganizationMember(activeOrg.id, memberId);
            await fetchData();
            onChanged?.();
        } catch (e) {
            console.error("Failed to remove member:", e);
            alert("Erreur lors de la suppression du membre.");
        }
    };

    const handleStartApproval = (inv: Invitation) => {
        setApprovingInvite(inv);
        setApprovingComptaRoles({});
    };

    const handleConfirmApproval = async () => {
        if (!activeOrg || !user || !approvingInvite) return;
        setIsApproving(true);
        try {
            await approveInvitationWithAccess(activeOrg.id, approvingInvite.id, user.uid, approvingComptaRoles);
            setApprovingInvite(null);
            setApprovingComptaRoles({});
            await fetchData();
            onChanged?.();
            alert("Membre approuvé et accès configurés avec succès !");
        } catch (e) {
            console.error("Approval error", e);
            alert("Erreur lors de l'approbation.");
        } finally {
            setIsApproving(false);
        }
    };

    const handleReject = async (inviteId: string) => {
        if (!activeOrg || !user) return;
        if (!window.confirm("Refuser cette demande d'adhésion ?")) return;
        try {
            await rejectInvitation(activeOrg.id, inviteId, user.uid);
            await fetchData();
            onChanged?.();
        } catch (e) {
            console.error(e);
        }
    };

    if (!activeOrg) {
        return <div className="p-8 text-center text-slate-400">Aucune organisation sélectionnée.</div>;
    }

    // ============================================================================
    // MODE 1 : ADMINISTRATION D'UNE COMPTABILITÉ SPÉCIFIQUE (POUR LE CAISSIER)
    // ============================================================================
    if (effectiveMode === 'compta' && selectedCompta) {
        if (!isComptaCaissier) {
            return (
                <div className="p-8 text-center text-red-500">
                    Accès réservé au Caissier de cette comptabilité ou à l'Administrateur de l'association.
                </div>
            );
        }

        const comptaMembersList = registeredUsers.filter(regUser => {
            const m = members.find(
                mem => mem.email?.toLowerCase() === regUser.email.toLowerCase() || mem.uid === regUser.uid || mem.id === regUser.uid
            );
            return Boolean(m?.comptaAccess?.[selectedCompta.id]);
        });

        return (
            <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
                {/* En-tête compact avec bouton Lien d'inscription intégré */}
                <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-xl px-5 py-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <Shield className="text-blue-500 shrink-0" size={20} />
                            <h2 className="text-lg sm:text-xl font-bold text-slate-100">
                                Accès & Vérificateurs — <span className="text-blue-400">{selectedCompta.name}</span>
                            </h2>
                        </div>
                        <p className="text-slate-400 text-xs sm:text-sm mt-0.5">
                            Nommez les <strong>Vérificateurs</strong> et <strong>Lecteurs</strong> pour cette comptabilité ou copiez le lien d'inscription.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleGenerateLink}
                        className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 border transition-all shrink-0 cursor-pointer ${
                            copiedLink
                                ? 'bg-emerald-950/70 border-emerald-700 text-emerald-300'
                                : 'bg-blue-600 hover:bg-blue-500 border-blue-500 text-white shadow-sm'
                        }`}
                    >
                        {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                        {copiedLink ? 'Lien copié !' : "Copier le lien d'inscription"}
                    </button>
                </header>

                {loading ? (
                    <div className="flex justify-center p-10 text-slate-500">
                        <Loader2 className="animate-spin" size={28} />
                    </div>
                ) : (
                    <>
                        {/* Barre horizontale compacte d'ajout / modification pour cette comptabilité */}
                        <form onSubmit={handleSaveSingleComptaAccess} className="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow-sm space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                                    <UserPlus size={16} className="text-emerald-500" />
                                    Donner ou modifier un accès sur « {selectedCompta.name} »
                                </h3>
                                <span className="text-xs text-slate-500">{registeredUsers.length} utilisateurs inscrits</span>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                                <div className="md:col-span-4">
                                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                                        1. Choisir un inscrit
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
                                                const existing = members.find(
                                                    m => m.email?.toLowerCase() === found.email.toLowerCase() || m.uid === found.uid
                                                );
                                                const existingComptaRole = existing?.comptaAccess?.[selectedCompta.id];
                                                setSingleComptaRole(existingComptaRole || ComptaRole.VERIFICATEUR);
                                            }
                                        }}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs sm:text-sm focus:outline-none focus:border-blue-500"
                                    >
                                        <option value="">-- Sélectionner parmi les inscrits --</option>
                                        {registeredUsers.map(u => {
                                            const m = members.find(
                                                mem => mem.email?.toLowerCase() === u.email.toLowerCase() || mem.uid === u.uid
                                            );
                                            const currentRole = m?.comptaAccess?.[selectedCompta.id];
                                            const roleTag = currentRole
                                                ? ` [${currentRole === 'caissier' || currentRole === 'comptable' ? 'Caissier' : currentRole === 'verificateur' ? 'Vérificateur' : 'Lecteur'}]`
                                                : '';
                                            return (
                                                <option key={u.uid} value={u.uid}>
                                                    {u.displayName} ({u.email}){roleTag}
                                                </option>
                                            );
                                        })}
                                    </select>
                                </div>

                                <div className="md:col-span-3">
                                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">Email *</label>
                                    <input
                                        type="email"
                                        value={memberEmail}
                                        onChange={e => setMemberEmail(e.target.value)}
                                        placeholder="verificateur@asso.ch"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs sm:text-sm focus:outline-none focus:border-blue-500"
                                        required
                                    />
                                </div>

                                <div className="md:col-span-3">
                                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                                        Rôle sur « {selectedCompta.name} »
                                    </label>
                                    <select
                                        value={singleComptaRole}
                                        onChange={e => setSingleComptaRole(e.target.value as ComptaRole | 'none')}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs sm:text-sm focus:outline-none focus:border-blue-500"
                                    >
                                        <option value={ComptaRole.VERIFICATEUR}>🔍 Vérificateur (Contrôle & notes)</option>
                                        <option value={ComptaRole.VIEWER}>👁️ Lecteur (Consultation)</option>
                                        {isOrgAdmin && (
                                            <option value={ComptaRole.CAISSIER}>💼 Caissier (Accès complet)</option>
                                        )}
                                        <option value="none">🚫 Retirer l'accès</option>
                                    </select>
                                </div>

                                <div className="md:col-span-2">
                                    <button
                                        type="submit"
                                        disabled={isSavingMember || !memberEmail.trim()}
                                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 cursor-pointer h-[38px]"
                                    >
                                        {isSavingMember ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                                        Valider
                                    </button>
                                </div>
                            </div>
                        </form>

                        {/* Liste compacte des membres ayant accès à cette comptabilité */}
                        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                            <div className="px-4 py-3 border-b border-slate-800 bg-slate-950 flex justify-between items-center">
                                <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                                    <Users size={16} className="text-blue-500" />
                                    Membres ayant accès à « {selectedCompta.name} » ({comptaMembersList.length})
                                </h3>
                            </div>

                            {comptaMembersList.length === 0 ? (
                                <div className="p-6 text-center text-slate-500 italic text-xs sm:text-sm">
                                    Aucun vérificateur ou lecteur n'est encore assigné à cette comptabilité.
                                </div>
                            ) : (
                                <div className="divide-y divide-slate-800/70">
                                    {comptaMembersList.map(regUser => {
                                        const m = members.find(
                                            mem => mem.email?.toLowerCase() === regUser.email.toLowerCase() || mem.uid === regUser.uid || mem.id === regUser.uid
                                        );
                                        const roleOnThisCompta = m?.comptaAccess?.[selectedCompta.id] || 'none';
                                        const isMemberCaissier = roleOnThisCompta === 'caissier' || roleOnThisCompta === 'comptable';

                                        return (
                                            <div key={regUser.uid || regUser.email} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-800/30 transition-colors">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <span className="font-semibold text-slate-200 text-sm truncate">
                                                        {m?.displayName || regUser.displayName || regUser.email}
                                                    </span>
                                                    <span className="text-slate-500 text-xs truncate hidden sm:inline">
                                                        ({regUser.email})
                                                    </span>
                                                </div>

                                                <div className="flex items-center gap-2 shrink-0">
                                                    {(!isMemberCaissier || isOrgAdmin) ? (
                                                        <select
                                                            value={roleOnThisCompta}
                                                            onChange={(e) => handleQuickChangeSingleComptaRole(regUser, e.target.value as ComptaRole | 'none')}
                                                            className={`text-xs rounded-lg px-2.5 py-1 font-medium border focus:outline-none ${
                                                                isMemberCaissier
                                                                    ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-300'
                                                                    : roleOnThisCompta === 'verificateur'
                                                                    ? 'bg-amber-950/50 border-amber-800/60 text-amber-300'
                                                                    : 'bg-blue-950/50 border-blue-800/60 text-blue-300'
                                                            }`}
                                                        >
                                                            {isOrgAdmin && <option value={ComptaRole.CAISSIER}>💼 Caissier</option>}
                                                            <option value={ComptaRole.VERIFICATEUR}>🔍 Vérificateur</option>
                                                            <option value={ComptaRole.VIEWER}>👁️ Lecteur</option>
                                                            <option value="none">🚫 Retirer l'accès</option>
                                                        </select>
                                                    ) : (
                                                        <span className="text-xs px-2.5 py-1 rounded border bg-emerald-950/50 border-emerald-800/60 text-emerald-300 flex items-center gap-1">
                                                            <PenTool size={10} /> Caissier
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        );
    }

    // ============================================================================
    // MODE 2 : ADMINISTRATION GLOBALE DE L'ASSOCIATION (PLEINE LARGEUR, COMPACT)
    // ============================================================================
    if (!isOrgAdmin) {
        return <div className="p-8 text-center text-red-500">Accès refusé. Administrateurs uniquement.</div>;
    }

    const sortedComptas = [...comptas].sort((a, b) => Number(!!a.isArchived) - Number(!!b.isArchived));

    return (
        <div className={orgOverride ? "w-full space-y-5" : "p-4 md:p-6 max-w-6xl mx-auto space-y-5"}>
            {/* Barre supérieure : Titre + Lien d'inscription sur une seule ligne */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 bg-blue-950/70 text-blue-400 border border-blue-800/50 rounded-lg shrink-0">
                        <Users size={18} />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-base sm:text-lg font-bold text-white truncate">
                            Gestion des Membres & Rôles — {activeOrg.name}
                        </h2>
                        <p className="text-slate-400 text-xs truncate">
                            Attribuez les rôles globaux et les droits par comptabilité ou partagez le lien d'inscription.
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={handleGenerateLink}
                        className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 border transition-colors cursor-pointer ${
                            copiedLink
                                ? 'bg-emerald-950/70 border-emerald-700 text-emerald-300'
                                : 'bg-blue-600 hover:bg-blue-500 text-white border-blue-500 shadow-sm'
                        }`}
                    >
                        {copiedLink ? <Check size={14} /> : <Copy size={14} />}
                        {copiedLink ? "Lien copié !" : "Copier le lien d'inscription"}
                    </button>
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                            title="Fermer"
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>
            </div>

            {!hideComptasTab && (
                <div className="flex gap-2 border-b border-slate-800">
                    <button
                        onClick={() => setActiveTab('members')}
                        className={`px-4 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'members' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'
                        }`}
                    >
                        <Users size={15} />
                        Utilisateurs & Rôles ({registeredUsers.length})
                    </button>
                    <button
                        onClick={() => setActiveTab('comptas')}
                        className={`px-4 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                            activeTab === 'comptas' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'
                        }`}
                    >
                        <Book size={15} />
                        Comptabilités ({comptas.length})
                    </button>
                </div>
            )}

            {loading ? (
                <div className="flex justify-center p-10 text-slate-500">
                    <Loader2 className="animate-spin" size={28} />
                </div>
            ) : !hideComptasTab && activeTab === 'comptas' ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    <div className="md:col-span-1 bg-slate-900 border border-slate-800 p-4 rounded-xl h-fit">
                        <h3 className="font-semibold text-white mb-3 flex items-center gap-2 text-sm">
                            <Plus size={16} className="text-blue-500" />
                            Nouvelle Comptabilité
                        </h3>
                        <form onSubmit={handleCreateCompta} className="space-y-3">
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Nom</label>
                                <input
                                    type="text"
                                    placeholder="Ex: Groupe 26/27"
                                    value={newComptaName}
                                    onChange={e => setNewComptaName(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-blue-500"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Description</label>
                                <input
                                    type="text"
                                    placeholder="Optionnelle..."
                                    value={newComptaDesc}
                                    onChange={e => setNewComptaDesc(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white text-sm focus:outline-none focus:border-blue-500"
                                />
                            </div>
                            <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-500 flex justify-center items-center gap-2 text-xs font-semibold transition-colors">
                                <Plus size={15} /> Créer la comptabilité
                            </button>
                        </form>
                    </div>
                    <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 h-fit">
                        {comptas.map(c => {
                            const isEditingThis = editingComptaId === c.id;
                            return (
                                <div key={c.id} className="bg-slate-900 border border-slate-800 px-4 py-3 rounded-xl flex justify-between items-center gap-3 hover:border-slate-700 transition-colors">
                                    {isEditingThis ? (
                                        <div className="flex-1 space-y-2">
                                            <input
                                                type="text"
                                                value={editComptaName}
                                                onChange={e => setEditComptaName(e.target.value)}
                                                className="w-full bg-slate-950 border border-blue-500 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none"
                                                autoFocus
                                            />
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => handleSaveRenameCompta(c.id)}
                                                    disabled={isSavingComptaRename || !editComptaName.trim()}
                                                    className="px-2.5 py-1 bg-blue-600 text-white rounded text-xs font-semibold"
                                                >
                                                    Enregistrer
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setEditingComptaId(null)}
                                                    className="px-2.5 py-1 bg-slate-800 text-slate-300 rounded text-xs"
                                                >
                                                    Annuler
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <h4 className="font-bold text-white text-sm truncate">{c.name}</h4>
                                                    {c.isArchived && (
                                                        <span className="text-[10px] uppercase bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">Archivé</span>
                                                    )}
                                                </div>
                                                <p className="text-slate-400 text-xs truncate">{c.description || "Sans description"}</p>
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button
                                                    onClick={() => {
                                                        setEditingComptaId(c.id);
                                                        setEditComptaName(c.name);
                                                        setEditComptaDesc(c.description || '');
                                                    }}
                                                    className="text-slate-400 hover:text-blue-400 p-1.5 rounded-lg"
                                                    title="Renommer"
                                                >
                                                    <Edit2 size={15} />
                                                </button>
                                                <button
                                                    onClick={() => handleDeleteCompta(c.id)}
                                                    className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg"
                                                    title="Supprimer"
                                                >
                                                    <Trash2 size={15} />
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <div className="space-y-5">
                    {/* 1. LISTE DES MEMBRES EN HAUT : Plus large, moins haute, lecture immédiate */}
                    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                        <div className="px-4 py-3 border-b border-slate-800 bg-slate-950 flex flex-wrap justify-between items-center gap-2">
                            <div className="flex flex-wrap items-center gap-3">
                                <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                                    <Users size={16} className="text-blue-500" />
                                    Utilisateurs inscrits ({registeredUsers.length})
                                </h3>
                                <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border flex items-center gap-1 ${
                                    getUniqueAdminCount() >= 2
                                        ? 'bg-amber-950/50 border-amber-700/60 text-amber-300'
                                        : 'bg-purple-950/50 border-purple-700/60 text-purple-300'
                                }`}>
                                    <Shield size={11} />
                                    Admins du groupe : {getUniqueAdminCount()} / 2 max
                                </span>
                            </div>
                            <span className="text-xs text-slate-400">
                                Cliquez sur <strong>Modifier</strong> sur une ligne pour ajuster ses droits ci-dessous.
                            </span>
                        </div>

                        {registeredUsers.length === 0 ? (
                            <div className="p-6 text-center text-slate-500 italic text-sm">
                                Aucun utilisateur inscrit pour le moment.
                            </div>
                        ) : (
                            <div className="divide-y divide-slate-800/70">
                                {registeredUsers.map(regUser => {
                                    const m = members.find(
                                        mem => mem.email?.toLowerCase() === regUser.email.toLowerCase() || mem.uid === regUser.uid || mem.id === regUser.uid
                                    );
                                    const isAdmin = m?.role === OrgRole.ADMIN;
                                    const isOrgCaissier = m?.role === OrgRole.CAISSIER || (m?.role as string) === 'comptable';
                                    const accessEntries = Object.entries(m?.comptaAccess || {});
                                    const isUnassigned = !m;
                                    const isSelectedForEdit = memberEmail.toLowerCase() === regUser.email.toLowerCase();
                                    const otherAdminsCount = getUniqueAdminCount(regUser.email, regUser.uid);
                                    const maxAdminsReachedForThisUser = !isAdmin && otherAdminsCount >= 2;
                                    const isOnlyAdminForThisUser = isAdmin && otherAdminsCount === 0;

                                    return (
                                        <div
                                            key={regUser.uid || regUser.email}
                                            className={`px-4 py-2.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3 transition-colors ${
                                                isSelectedForEdit ? 'bg-blue-950/25 border-l-2 border-l-blue-500' : 'hover:bg-slate-800/30'
                                            }`}
                                        >
                                            {/* Colonne Gauche : Identité + Rôle global */}
                                            <div className="flex flex-wrap items-center gap-2 min-w-[240px] lg:w-1/3">
                                                <span className="font-semibold text-slate-100 text-sm">
                                                    {m?.displayName || regUser.displayName || regUser.email}
                                                </span>
                                                <span className="text-slate-400 text-xs">({regUser.email})</span>
                                                {isAdmin && (
                                                    <span className="text-[10px] font-bold uppercase bg-purple-900/40 border border-purple-800 text-purple-300 px-2 py-0.5 rounded">
                                                        🛡️ Admin
                                                    </span>
                                                )}
                                                {isOrgCaissier && (
                                                    <span className="text-[10px] font-bold uppercase bg-emerald-900/40 border border-emerald-800 text-emerald-300 px-2 py-0.5 rounded">
                                                        💼 Caissier Asso
                                                    </span>
                                                )}
                                                {isUnassigned && (
                                                    <span className="text-[10px] font-bold uppercase bg-amber-900/30 border border-amber-700/60 text-amber-300 px-2 py-0.5 rounded">
                                                        ⏳ Sans rôle
                                                    </span>
                                                )}
                                            </div>

                                            {/* Colonne Centrale : Badges de comptabilités sur une ligne horizontale */}
                                            <div className="flex flex-wrap items-center gap-1.5 flex-1">
                                                {isAdmin ? (
                                                    <span className="text-xs bg-purple-950/60 border border-purple-800/60 text-purple-300 px-2.5 py-0.5 rounded">
                                                        Accès Admin à toutes les comptabilités
                                                    </span>
                                                ) : accessEntries.length === 0 ? (
                                                    <span className="text-xs text-slate-500 italic">Aucune comptabilité assignée</span>
                                                ) : (
                                                    accessEntries.map(([cId, r]) => {
                                                        const comptaObj = comptas.find(c => c.id === cId);
                                                        const cName = comptaObj ? comptaObj.name : cId;
                                                        const isCaissier = r === 'caissier' || r === 'comptable';
                                                        const isVerif = r === 'verificateur';
                                                        return (
                                                            <span
                                                                key={cId}
                                                                className={`text-xs px-2 py-0.5 rounded border inline-flex items-center gap-1 ${
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

                                            {/* Colonne Droite : Actions compactes (Donner Admin réservé à l'Admin, min 1 / max 2 + Modifier + Supprimer) */}
                                            <div className="flex flex-wrap items-center gap-1.5 self-end lg:self-center shrink-0">
                                                {isOrgAdmin && (
                                                    <button
                                                        type="button"
                                                        disabled={isSavingMember || maxAdminsReachedForThisUser || isOnlyAdminForThisUser}
                                                        onClick={() => handleToggleOrgAdmin(regUser, m)}
                                                        className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1 border ${
                                                            isOnlyAdminForThisUser
                                                                ? 'text-purple-300/60 bg-purple-950/30 border-purple-800/40 opacity-60 cursor-not-allowed'
                                                                : isAdmin
                                                                ? 'text-purple-200 bg-purple-900/60 hover:bg-purple-800/70 border-purple-600/70 cursor-pointer'
                                                                : maxAdminsReachedForThisUser
                                                                ? 'text-slate-500 bg-slate-900/50 border-slate-800 opacity-50 cursor-not-allowed'
                                                                : 'text-purple-300 bg-purple-950/30 hover:bg-purple-900/50 border-purple-800/50 cursor-pointer'
                                                        }`}
                                                        title={
                                                            isOnlyAdminForThisUser
                                                                ? "Impossible de retirer le seul administrateur du groupe (minimum 1 requis)"
                                                                : isAdmin
                                                                ? "Retirer le rôle d'Administrateur du groupe"
                                                                : maxAdminsReachedForThisUser
                                                                ? "Limite de 2 administrateurs atteinte (2/2)"
                                                                : "Nommer Administrateur du groupe (1 à 2 admins)"
                                                        }
                                                    >
                                                        <Shield size={12} />
                                                        {isOnlyAdminForThisUser
                                                            ? "Admin (Min 1)"
                                                            : isAdmin
                                                            ? "Retirer Admin"
                                                            : maxAdminsReachedForThisUser
                                                            ? "Max 2 Admins"
                                                            : "Donner Admin"}
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (m) {
                                                            handleEditMember(m);
                                                        } else {
                                                            setSelectedFirebaseUserUid(regUser.uid);
                                                            setMemberEmail(regUser.email);
                                                            setMemberName(regUser.displayName);
                                                            setMemberOrgRole(OrgRole.MEMBER);
                                                            setMemberComptaRoles({});
                                                        }
                                                    }}
                                                    className="px-2.5 py-1 text-xs font-medium text-blue-300 bg-blue-950/50 hover:bg-blue-900/60 border border-blue-800/60 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                                                >
                                                    <Edit2 size={12} />
                                                    {isUnassigned ? "Donner un rôle" : "Modifier"}
                                                </button>
                                                {m && !isAdmin && (
                                                    <button
                                                        type="button"
                                                        onClick={() => m.id && handleRemoveMember(m.id)}
                                                        className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition-colors cursor-pointer"
                                                        title="Retirer les accès"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* 2. FORMULAIRE COMPACT EN GRILLE HORIZONTALE (Moins haut, 3 colonnes pour les comptas) */}
                    <div className="bg-slate-900 border border-slate-800 p-4 sm:p-5 rounded-xl shadow-sm">
                        <form onSubmit={handleSaveMemberAccess} className="space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800">
                                <h3 className="text-sm sm:text-base font-semibold text-white flex items-center gap-2">
                                    <UserPlus size={17} className="text-emerald-500" />
                                    Configurer les droits d'un membre
                                </h3>
                                <button
                                    type="submit"
                                    disabled={isSavingMember || !memberEmail.trim()}
                                    className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer shadow-sm"
                                >
                                    {isSavingMember ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                    Enregistrer les permissions
                                </button>
                            </div>

                            {/* Ligne 1 : 4 colonnes horizontales (Sélecteur inscrit, Email, Nom, Niveau 1 : Rôle Groupe) */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                <div>
                                    <label className="block text-[11px] font-semibold text-slate-300 mb-1 flex items-center gap-1">
                                        <UserCheck size={12} className="text-emerald-400" />
                                        Choisir un inscrit ({registeredUsers.length})
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
                                                    setMemberComptaRoles(existing.comptaAccess || {});
                                                } else {
                                                    setMemberOrgRole(OrgRole.MEMBER);
                                                    setMemberComptaRoles({});
                                                }
                                            }
                                        }}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                                    >
                                        <option value="">-- Sélectionner --</option>
                                        {registeredUsers.map(u => (
                                            <option key={u.uid} value={u.uid}>
                                                {u.displayName} ({u.email})
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">Email du membre *</label>
                                    <input
                                        type="email"
                                        value={memberEmail}
                                        onChange={e => setMemberEmail(e.target.value)}
                                        placeholder="membre@organisation.ch"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                                        required
                                    />
                                </div>

                                <div>
                                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">Nom / Prénom</label>
                                    <input
                                        type="text"
                                        value={memberName}
                                        onChange={e => setMemberName(e.target.value)}
                                        placeholder="Ex: Jean Dupont"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-xs focus:outline-none focus:border-blue-500"
                                    />
                                </div>

                                <div>
                                    <label className="block text-[11px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                                        <Shield size={12} className="text-purple-400" />
                                        <span className="text-purple-400 font-bold">Rôle Groupe :</span> Admin (max 2)
                                    </label>
                                    <select
                                        value={memberOrgRole}
                                        onChange={e => setMemberOrgRole(e.target.value as OrgRole)}
                                        disabled={!isOrgAdmin}
                                        className={`w-full border rounded-lg px-2.5 py-2 text-xs font-semibold focus:outline-none ${
                                            memberOrgRole === OrgRole.ADMIN
                                                ? 'bg-purple-950/60 border-purple-600 text-purple-200'
                                                : 'bg-slate-950 border-slate-700 text-white focus:border-blue-500'
                                        }`}
                                    >
                                        <option value={OrgRole.MEMBER}>Membre (Selon comptabilités)</option>
                                        <option value={OrgRole.CAISSIER}>💼 Caissier du Groupe</option>
                                        {isOrgAdmin && (
                                            <option
                                                value={OrgRole.ADMIN}
                                                disabled={getUniqueAdminCount(memberEmail, selectedFirebaseUserUid) >= 2}
                                            >
                                                {getUniqueAdminCount(memberEmail, selectedFirebaseUserUid) >= 2
                                                    ? '🛡️ Administrateur du Groupe (Max 2/2 atteint)'
                                                    : '🛡️ Administrateur du Groupe (Complet)'}
                                            </option>
                                        )}
                                    </select>
                                </div>
                            </div>

                            {memberOrgRole === OrgRole.ADMIN && (
                                <div className="bg-purple-950/40 border border-purple-700/60 rounded-lg px-3.5 py-2 flex items-center gap-2 text-xs text-purple-200">
                                    <Shield size={15} className="text-purple-400 shrink-0" />
                                    <span>
                                        <strong>Administrateur du groupe ({activeOrg.name}) — Limité à 2 max :</strong> ce membre aura automatiquement accès à toutes les comptabilités et pourra gérer les membres.
                                    </span>
                                </div>
                            )}

                            {/* Ligne 2 : Grille multi-colonnes compacte pour les Comptabilités (2 ou 3 par ligne au lieu d'une longue colonne) */}
                            <div className="pt-2 border-t border-slate-800/80">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
                                        <span className="text-emerald-400 font-bold">Niveau 2 :</span> Accès par Comptabilité
                                    </label>
                                    <span className="text-[11px] text-slate-500">
                                        💼 Caissier • 🔍 Vérificateur • 👁️ Lecteur
                                    </span>
                                </div>

                                {sortedComptas.length === 0 ? (
                                    <p className="text-xs text-slate-500 italic">Aucune comptabilité créée.</p>
                                ) : (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                                        {sortedComptas.map(c => {
                                            const currentRole = memberComptaRoles[c.id] || 'none';
                                            return (
                                                <div
                                                    key={c.id}
                                                    className={`flex items-center justify-between px-3 py-2 bg-slate-950 rounded-lg border gap-2 ${
                                                        c.isArchived ? 'border-slate-800/50 opacity-70' : 'border-slate-800'
                                                    }`}
                                                >
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className={`text-xs font-semibold truncate ${c.isArchived ? 'text-slate-400 line-through' : 'text-white'}`}>
                                                                {c.name}
                                                            </span>
                                                            {c.isArchived && (
                                                                <span className="text-[9px] uppercase bg-slate-800 text-slate-400 px-1 py-0.2 rounded shrink-0">
                                                                    Arch.
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
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
                                                        className={`text-xs rounded-md px-2 py-1 font-medium border focus:outline-none transition-colors shrink-0 ${
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
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
