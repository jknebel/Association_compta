import React, { useState, useEffect } from 'react';
import { useAuthContext, useOrgContext, useComptaContext } from '../contexts/AppContext';
import { Organization, Comptabilite } from '../types/rbac';
import {
    listAllOrganizations,
    getUserOrganizations,
    listComptabilites,
    listOrganizationMembers,
    createComptabilite,
    deleteComptabilite,
    toggleArchiveComptabilite,
    renameComptabilite,
    suggestNextComptaName,
    getComptaBalanceSummary,
    closeAndRolloverComptabilite
} from '../services/organizationService';
import { getUserComptabilites } from '../services/userService';
import { Building2, Book, Plus, ArrowRight, Loader2, LogOut, Trash2, Archive, ArchiveRestore, Database, Sparkles, Shield, Edit2, Calendar, X, CheckCircle, Users } from 'lucide-react';
import { logout } from '../services/authService';
import { checkLegacyData, LegacyDataSummary, connectCurrentCompta, markLegacyMigrationDone } from '../services/migrationService';
import { UnauthorizedView } from './UnauthorizedView';
import { AdminView } from './AdminView';

export const OrgSelector: React.FC = () => {
    const { user, isSuperAdmin } = useAuthContext();
    const { setSelectedOrg, setOrgRole } = useOrgContext();
    const { setSelectedCompta, setComptaRole } = useComptaContext();
    
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [adminOrgIds, setAdminOrgIds] = useState<Record<string, boolean>>({});
    const [caissierOrgIds, setCaissierOrgIds] = useState<Record<string, boolean>>({});
    const [comptasByOrg, setComptasByOrg] = useState<Record<string, Array<{compta: Comptabilite, role: any}>>>({});
    const [loading, setLoading] = useState(true);
    const [legacySummary, setLegacySummary] = useState<LegacyDataSummary | null>(null);
    const [hasLegacyData, setHasLegacyData] = useState(false);
    const [isConnectingLegacy, setIsConnectingLegacy] = useState(false);
    const [isCreatingCompta, setIsCreatingCompta] = useState<string | null>(null); // orgId
    const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
    const [activeTabByOrg, setActiveTabByOrg] = useState<Record<string, 'comptas' | 'members'>>({});
    const [newComptaNameByOrg, setNewComptaNameByOrg] = useState<Record<string, string>>({});
    const [newComptaDescByOrg, setNewComptaDescByOrg] = useState<Record<string, string>>({});

    // Rename Modal State
    const [renamingTarget, setRenamingTarget] = useState<{ orgId: string; compta: Comptabilite } | null>(null);
    const [renameNameInput, setRenameNameInput] = useState('');
    const [renameDescInput, setRenameDescInput] = useState('');
    const [isSavingRename, setIsSavingRename] = useState(false);

    // Close & Rollover Modal State
    const [closingTarget, setClosingTarget] = useState<{ org: Organization; compta: Comptabilite } | null>(null);
    const [closingDateInput, setClosingDateInput] = useState(() => new Date().toISOString().split('T')[0]);
    const [closingBaseName, setClosingBaseName] = useState('');
    const [closingPeriodInput, setClosingPeriodInput] = useState('');
    const [closingNewNameInput, setClosingNewNameInput] = useState('');
    const [closingCustomNameEdited, setClosingCustomNameEdited] = useState(false);
    const [closingCarryOverBalance, setClosingCarryOverBalance] = useState<number>(0);
    const [closingSummary, setClosingSummary] = useState<{
        openingBalance: number;
        totalIncome: number;
        totalExpense: number;
        totalMovements: number;
        closingBalance: number;
        transactionsCount: number;
    } | null>(null);
    const [isLoadingClosingSummary, setIsLoadingClosingSummary] = useState(false);
    const [isSubmittingClose, setIsSubmittingClose] = useState(false);

    const [isRefreshingAccess, setIsRefreshingAccess] = useState(false);

    const fetchData = async (silent = false) => {
        if (!user) return;
        if (!silent) {
            setLoading(true);
        } else {
            setIsRefreshingAccess(true);
        }
        try {
            // Check legacy data summary (Firestore and localStorage)
            const summary = await checkLegacyData(user.uid);
            setLegacySummary(summary);
            setHasLegacyData(summary.hasData);

            // Fetch Organizations
            let orgs: Organization[] = [];
            if (isSuperAdmin) {
                orgs = await listAllOrganizations();
            } else {
                orgs = await getUserOrganizations(user.uid, user.email || undefined);
            }

            // Fetch Comptas and roles defined in Firebase
            const userComptas = await getUserComptabilites(user.uid, user.email || undefined);
            
            const userRoleByComptaId: Record<string, any> = {};
            userComptas.forEach(uc => {
                userRoleByComptaId[uc.compta.id] = uc.role;
            });

            const byOrg: Record<string, Array<{compta: Comptabilite, role: any}>> = {};
            const orgAdminMap: Record<string, boolean> = {};
            const orgCaissierMap: Record<string, boolean> = {};
            
            if (isSuperAdmin) {
                // SuperAdmin a accès à TOUTES les comptas
                for (const org of orgs) {
                    orgAdminMap[org.id] = true;
                    const allComptas = await listComptabilites(org.id);
                    byOrg[org.id] = allComptas.map(c => ({ 
                        compta: c, 
                        role: userRoleByComptaId[c.id] || 'caissier' 
                    }));
                }
            } else {
                // Admin d'une organisation a accès à toutes les comptabilités de son organisation
                for (const org of orgs) {
                    const orgMembers = await listOrganizationMembers(org.id);
                    const normalizedUserEmail = user.email?.trim().toLowerCase();
                    const isMemberAdmin = orgMembers.some(m => 
                        m.role === 'admin' && 
                        m.status !== 'rejected' && 
                        (m.uid === user.uid || m.id === user.uid || (normalizedUserEmail && m.email?.trim().toLowerCase() === normalizedUserEmail))
                    );
                    const isMemberCaissier = orgMembers.some(m => 
                        (m.role === 'caissier' || (m.role as string) === 'comptable') && 
                        m.status !== 'rejected' && 
                        (m.uid === user.uid || m.id === user.uid || (normalizedUserEmail && m.email?.trim().toLowerCase() === normalizedUserEmail))
                    );
                    if (isMemberCaissier) {
                        orgCaissierMap[org.id] = true;
                    }
                    const isOrgAdmin = isMemberAdmin || org.createdBy === user.uid || (normalizedUserEmail && org.adminEmail && org.adminEmail.trim().toLowerCase() === normalizedUserEmail);
                    if (isOrgAdmin) {
                        orgAdminMap[org.id] = true;
                        const allComptas = await listComptabilites(org.id);
                        byOrg[org.id] = allComptas.map(c => ({ 
                            compta: c, 
                            role: userRoleByComptaId[c.id] || 'caissier' 
                        }));
                    }
                }

                // Pour les comptas où l'utilisateur est assigné dans Firebase
                userComptas.forEach(uc => {
                    if (!byOrg[uc.orgId]) byOrg[uc.orgId] = [];
                    if (!byOrg[uc.orgId].some(item => item.compta.id === uc.compta.id)) {
                        byOrg[uc.orgId].push({ compta: uc.compta, role: uc.role });
                    }
                });
            }
            
            setOrganizations(orgs);
            setAdminOrgIds(orgAdminMap);
            setCaissierOrgIds(orgCaissierMap);
            setComptasByOrg(byOrg);
        } catch (err) {
            console.error("Error fetching orgs/comptas:", err);
        } finally {
            setLoading(false);
            setIsRefreshingAccess(false);
        }
    };

    useEffect(() => {
        fetchData(false);
    }, [user, isSuperAdmin]);

    const isOrgAdminOf = (org: Organization) => {
        if (isSuperAdmin) return true;
        if (adminOrgIds[org.id]) return true;
        if (user && org.createdBy === user.uid) return true;
        if (user?.email && org.adminEmail && org.adminEmail.trim().toLowerCase() === user.email.trim().toLowerCase()) return true;
        return false;
    };

    const handleSelectCompta = (org: Organization, comptaData: {compta: Comptabilite, role: any}) => {
        setSelectedOrg(org);
        const isOrgAdmin = isOrgAdminOf(org);
        setOrgRole(isOrgAdmin ? 'admin' : 'member');
        
        setSelectedCompta(comptaData.compta);
        if (comptaData.compta.isArchived) {
            setComptaRole('viewer' as any); // Lecture seule
        } else {
            setComptaRole(comptaData.role);
        }
    };

    const handleCreateCompta = async (e: React.FormEvent, orgId: string) => {
        e.preventDefault();
        if (!user) return;
        const name = (newComptaNameByOrg[orgId] || '').trim();
        const description = (newComptaDescByOrg[orgId] || '').trim();
        if (!name) return;

        setIsCreatingCompta(orgId);
        try {
            await createComptabilite(orgId, { 
                name,
                description,
                createdBy: user.uid,
                fiscalYearStart: '2026-01-01',
                fiscalYearEnd: '2026-12-31',
                currency: 'CHF'
            }, user.uid);
            setNewComptaNameByOrg(prev => ({ ...prev, [orgId]: '' }));
            setNewComptaDescByOrg(prev => ({ ...prev, [orgId]: '' }));
            await fetchData(true);
        } catch (e) {
            console.error(e);
            alert("Erreur lors de la création.");
        } finally {
            setIsCreatingCompta(null);
        }
    };

    const handleDelete = async (e: React.MouseEvent, orgId: string, comptaId: string) => {
        e.stopPropagation();
        if (window.confirm("Êtes-vous sûr de vouloir supprimer DÉFINITIVEMENT cette comptabilité et toutes ses données (comptes, transactions, etc) ? Cette action est irréversible.")) {
            try {
                await deleteComptabilite(orgId, comptaId);
                await fetchData(true);
            } catch (err) {
                console.error(err);
                alert("Erreur lors de la suppression.");
            }
        }
    };

    const handleOpenRename = (e: React.MouseEvent, orgId: string, compta: Comptabilite) => {
        e.stopPropagation();
        setRenamingTarget({ orgId, compta });
        setRenameNameInput(compta.name);
        setRenameDescInput(compta.description || '');
    };

    const handleSaveRename = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!renamingTarget || !renameNameInput.trim()) return;
        setIsSavingRename(true);
        try {
            const newName = renameNameInput.trim();
            const newDesc = renameDescInput.trim();
            await renameComptabilite(renamingTarget.orgId, renamingTarget.compta.id, newName, newDesc);
            setComptasByOrg(prev => {
                const orgList = prev[renamingTarget.orgId] || [];
                return {
                    ...prev,
                    [renamingTarget.orgId]: orgList.map(item =>
                        item.compta.id === renamingTarget.compta.id
                            ? { ...item, compta: { ...item.compta, name: newName, description: newDesc } }
                            : item
                    )
                };
            });
            setRenamingTarget(null);
        } catch (err) {
            console.error(err);
            alert("Erreur lors du renommage de la comptabilité.");
        } finally {
            setIsSavingRename(false);
        }
    };

    const handleOpenClosingModal = async (e: React.MouseEvent, org: Organization, compta: Comptabilite) => {
        e.stopPropagation();
        if (compta.isArchived) {
            // Unarchive directly if already archived
            try {
                await toggleArchiveComptabilite(org.id, compta.id, false);
                await fetchData();
            } catch (err) {
                console.error(err);
                alert("Erreur lors de la restauration de l'archive.");
            }
            return;
        }

        const suggestion = suggestNextComptaName(compta.name);
        setClosingTarget({ org, compta });
        setClosingDateInput(new Date().toISOString().split('T')[0]);
        setClosingBaseName(suggestion.baseName);
        setClosingPeriodInput(suggestion.suggestedNextPeriod);
        setClosingNewNameInput(suggestion.suggestedFullName);
        setClosingCustomNameEdited(false);
        setClosingSummary(null);
        setClosingCarryOverBalance(0);
        setIsLoadingClosingSummary(true);

        try {
            const summary = await getComptaBalanceSummary(org.id, compta.id);
            setClosingSummary(summary);
            setClosingCarryOverBalance(summary.closingBalance);
        } catch (err) {
            console.error("Erreur lors du calcul du solde de clôture:", err);
        } finally {
            setIsLoadingClosingSummary(false);
        }
    };

    const handlePeriodChangeInModal = (periodVal: string) => {
        setClosingPeriodInput(periodVal);
        if (!closingCustomNameEdited) {
            const nextName = periodVal.trim()
                ? `${closingBaseName} ${periodVal.trim()}`.trim()
                : closingBaseName;
            setClosingNewNameInput(nextName);
        }
    };

    const handleConfirmRollover = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!closingTarget || !user || !closingNewNameInput.trim()) return;
        setIsSubmittingClose(true);
        try {
            const newCompta = await closeAndRolloverComptabilite({
                orgId: closingTarget.org.id,
                oldComptaId: closingTarget.compta.id,
                newComptaName: closingNewNameInput.trim(),
                closingDate: closingDateInput || new Date().toISOString().split('T')[0],
                carryOverBalance: Number(closingCarryOverBalance || 0),
                creatorUid: user.uid
            });
            const targetOrg = closingTarget.org;
            setClosingTarget(null);
            await fetchData();
            // Open the newly created comptabilité directly
            handleSelectCompta(targetOrg, { compta: newCompta, role: 'caissier' });
        } catch (err) {
            console.error("Erreur lors de la clôture et itération:", err);
            alert("Erreur lors de la clôture et création du nouvel exercice.");
        } finally {
            setIsSubmittingClose(false);
        }
    };

    const handleArchiveOnly = async () => {
        if (!closingTarget) return;
        setIsSubmittingClose(true);
        try {
            await toggleArchiveComptabilite(closingTarget.org.id, closingTarget.compta.id, true);
            setClosingTarget(null);
            await fetchData();
        } catch (err) {
            console.error(err);
            alert("Erreur lors de l'archivage.");
        } finally {
            setIsSubmittingClose(false);
        }
    };

    const handleAutoConnectLegacy = async (targetOrgId?: string) => {
        if (!user) return;
        setIsConnectingLegacy(true);
        try {
            let finalTargetOrgId = targetOrgId;
            let targetOrg = organizations.find(o => o.id === finalTargetOrgId);

            if (!finalTargetOrgId) {
                if (organizations.length === 1) {
                    const confirmUseSingle = window.confirm(`Voulez-vous connecter votre comptabilité actuelle dans votre association "${organizations[0].name}" ?\n\n(Cliquez sur Annuler pour créer une nouvelle association)`);
                    if (confirmUseSingle) {
                        finalTargetOrgId = organizations[0].id;
                        targetOrg = organizations[0];
                    }
                } else if (organizations.length > 1) {
                    const orgListNames = organizations.map((o, idx) => `${idx + 1}. ${o.name}`).join('\n');
                    const choice = prompt(`Dans quelle association souhaitez-vous connecter votre comptabilité actuelle ?\n\n${orgListNames}\n\nEntrez le numéro correspondant (ou laissez vide pour créer une nouvelle association) :`);
                    if (choice) {
                        const idx = parseInt(choice.trim(), 10) - 1;
                        if (organizations[idx]) {
                            finalTargetOrgId = organizations[idx].id;
                            targetOrg = organizations[idx];
                        }
                    }
                }
            }

            let newOrgName = "Mon Association";
            if (!finalTargetOrgId) {
                const entered = prompt("Nom de votre association pour cette comptabilité :", "Mon Association");
                if (!entered) {
                    setIsConnectingLegacy(false);
                    return;
                }
                newOrgName = entered;
            }

            const comptaName = prompt("Nom de la comptabilité/exercice pour vos données actuelles ?", "Comptabilité principale") || "Comptabilité principale";

            const result = await connectCurrentCompta(user, finalTargetOrgId, newOrgName, comptaName);
            
            // Immediately open the workspace with newly migrated data
            handleSelectCompta(result.org, { compta: result.compta, role: 'caissier' });
        } catch (err: any) {
            console.error("Erreur de connexion:", err);
            alert("Erreur lors de la connexion de la comptabilité : " + (err.message || "Erreur inconnue"));
        } finally {
            setIsConnectingLegacy(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-4">
                <Loader2 className="animate-spin text-blue-500" size={32} />
                <span>Chargement de vos espaces...</span>
            </div>
        );
    }

    const hasAnyAccess = isSuperAdmin || 
        organizations.some(org => isOrgAdminOf(org) || caissierOrgIds[org.id]) || 
        Object.values(comptasByOrg).some(list => list.length > 0) ||
        hasLegacyData;

    if (!hasAnyAccess) {
        return (
            <UnauthorizedView 
                email={user?.email || ''} 
                onRefresh={() => fetchData(true)} 
                isRefreshing={isRefreshingAccess || loading} 
            />
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center p-4 md:p-8">
            <div className="w-full max-w-6xl transition-all">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 md:mb-8">
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-1 sm:mb-2">
                            <span className="text-blue-500">Asso</span>Compta AI
                        </h1>
                        <p className="text-sm sm:text-base text-slate-400">Sélectionnez une comptabilité ou gérez votre association</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
                        {isSuperAdmin && (
                            <button 
                                onClick={() => { window.location.hash = '#superadmin'; }}
                                className="flex items-center gap-2 px-3 py-2 bg-purple-950/60 hover:bg-purple-900/80 text-purple-200 border border-purple-800/60 rounded-lg text-xs font-semibold transition-all cursor-pointer shadow-md shadow-purple-950/40"
                            >
                                <Shield size={14} className="text-purple-400 shrink-0" />
                                <span>Super Admin</span>
                            </button>
                        )}
                        <button 
                            onClick={async () => { await logout(); window.location.href = '/'; }}
                            className="flex items-center gap-2 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg text-xs sm:text-sm transition-colors border border-slate-800"
                        >
                            <LogOut size={16} />
                            Déconnexion
                        </button>
                    </div>
                </div>

                {/* Legacy Data Detection & 1-Click Connect Banner */}
                {legacySummary && legacySummary.hasData && (
                    <div className="bg-gradient-to-r from-blue-950/70 via-indigo-950/70 to-slate-900 border border-blue-500/40 rounded-xl p-5 mb-8 shadow-xl shadow-blue-950/40">
                        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                            <div className="flex items-start gap-3.5">
                                <div className="p-3 bg-blue-600/20 text-blue-400 rounded-lg shrink-0 border border-blue-500/20">
                                    <Database size={24} />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-base font-semibold text-white">
                                            Comptabilité V1 détectée (Migration vers la V2)
                                        </h3>
                                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded border border-blue-400/30">
                                            Usage unique
                                        </span>
                                    </div>
                                    <p className="text-sm text-slate-300 mt-1">
                                        <span className="font-semibold text-white">{legacySummary.accountsCount}</span> comptes, <span className="font-semibold text-white">{legacySummary.transactionsCount}</span> transactions
                                        {legacySummary.receiptsCount > 0 ? <>, <span className="font-semibold text-white">{legacySummary.receiptsCount}</span> pièces comptables</> : ''}
                                        {legacySummary.hasAiConfig ? ' et règles IA' : ''}.
                                    </p>
                                    <p className="text-xs text-slate-400 mt-1">
                                        Permet de migrer votre comptabilité V1 vers votre nouvelle organisation. Une fois migrée, cette option disparaît définitivement.
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 w-full md:w-auto shrink-0 justify-end">
                                <button
                                    onClick={async () => {
                                        if (user) {
                                            await markLegacyMigrationDone(user.uid);
                                            setHasLegacyData(false);
                                            setLegacySummary(null);
                                        }
                                    }}
                                    className="px-3.5 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 rounded-lg transition-colors border border-slate-700/60"
                                    title="Masquer définitivement si déjà migrée"
                                >
                                    Déjà migrée (masquer)
                                </button>
                                <button
                                    onClick={() => handleAutoConnectLegacy()}
                                    disabled={isConnectingLegacy}
                                    className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white font-medium rounded-lg shadow-lg shadow-blue-600/30 transition-all cursor-pointer"
                                >
                                    {isConnectingLegacy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
                                    Migrer ma compta V1
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {organizations.length === 0 ? (
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center">
                        <Building2 size={48} className="mx-auto text-slate-600 mb-4" />
                        <h2 className="text-xl font-semibold text-white mb-2">Aucune organisation configurée</h2>
                        <p className="text-slate-400 mb-6 max-w-md mx-auto">
                            {hasLegacyData 
                                ? "Vous avez une comptabilité prête à être utilisée. Cliquez sur 'Connecter ma compta actuelle' pour créer votre organisation et y retrouver immédiatement toutes vos données."
                                : "Vous n'êtes membre d'aucune organisation pour le moment. Veuillez demander à un administrateur de vous inviter."}
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-3">
                            {hasLegacyData && (
                                <button 
                                    onClick={() => handleAutoConnectLegacy()}
                                    disabled={isConnectingLegacy}
                                    className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 rounded-lg transition-colors font-medium inline-flex items-center gap-2 shadow-lg shadow-blue-600/20"
                                >
                                    {isConnectingLegacy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
                                    Connecter ma compta actuelle
                                </button>
                            )}
                            {isSuperAdmin && (
                                <button 
                                    onClick={() => { window.location.hash = '#superadmin'; }}
                                    className="bg-purple-900/60 hover:bg-purple-800 text-purple-200 border border-purple-700/60 px-6 py-2.5 rounded-lg transition-colors font-medium inline-flex items-center gap-2 shadow-lg shadow-purple-900/20 cursor-pointer"
                                >
                                    <Shield size={18} />
                                    Créer une organisation (Panneau Super Admin)
                                </button>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {organizations.map(org => {
                            const isOrgAdmin = isOrgAdminOf(org);
                            const allComptas = comptasByOrg[org.id] || [];
                            const activeComptas = allComptas.filter(c => !c.compta.isArchived);
                            const archivedComptas = allComptas.filter(c => c.compta.isArchived);
                            const onlyHasArchived = activeComptas.length === 0 && archivedComptas.length > 0;
                            const comptasToShow = (showArchived[org.id] || onlyHasArchived) ? allComptas : activeComptas;
                            const currentTab = activeTabByOrg[org.id] || 'comptas';
                            const hasCaissierAccess = isSuperAdmin || isOrgAdmin || caissierOrgIds[org.id] || allComptas.some(c => c.role === 'caissier' || c.role === 'comptable' || c.role === 'admin');

                            return (
                                <div key={org.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl shadow-black/30">
                                    {/* En-tête de l'association + Onglets de navigation en haut */}
                                    <div className="px-6 pt-5 pb-0 border-b border-slate-800 bg-slate-900/80">
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4">
                                            <div>
                                                <div className="flex items-center gap-2.5">
                                                    <div className="p-2 bg-blue-600/15 text-blue-400 rounded-lg border border-blue-500/20">
                                                        <Building2 size={20} />
                                                    </div>
                                                    <div>
                                                        <div className="flex items-center gap-2.5">
                                                            <h2 className="text-xl font-bold text-white">{org.name}</h2>
                                                            {isSuperAdmin ? (
                                                                <span className="px-2 py-0.5 bg-purple-900/30 text-purple-300 border border-purple-700/50 rounded text-[11px] font-bold uppercase tracking-wider">
                                                                    Super Admin
                                                                </span>
                                                            ) : isOrgAdmin ? (
                                                                <span className="px-2 py-0.5 bg-blue-900/30 text-blue-300 border border-blue-700/50 rounded text-[11px] font-bold uppercase tracking-wider">
                                                                    Admin Groupe
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                        <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
                                                            {org.description || "Espace de comptabilité de l'association"}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>

                                            {hasLegacyData && (isSuperAdmin || isOrgAdmin) && (
                                                <button
                                                    onClick={() => handleAutoConnectLegacy(org.id)}
                                                    disabled={isConnectingLegacy}
                                                    className="flex items-center gap-2 px-3.5 py-2 bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 border border-indigo-800/50 rounded-lg text-xs font-semibold transition-colors cursor-pointer self-start sm:self-center"
                                                >
                                                    {isConnectingLegacy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                                                    Connecter ma compta V1 ici
                                                </button>
                                            )}
                                        </div>

                                        {/* Barre d'onglets en haut */}
                                        <div className="flex items-center gap-2 -mb-px overflow-x-auto">
                                            <button
                                                type="button"
                                                onClick={() => setActiveTabByOrg(prev => ({ ...prev, [org.id]: 'comptas' }))}
                                                className={`px-4 py-3 text-xs sm:text-sm font-semibold border-b-2 transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
                                                    currentTab === 'comptas'
                                                        ? 'border-blue-500 text-blue-400 bg-blue-950/20 rounded-t-lg'
                                                        : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 rounded-t-lg'
                                                }`}
                                            >
                                                <Book size={16} />
                                                <span>Gestion des Comptabilités ({activeComptas.length})</span>
                                            </button>

                                            {(isSuperAdmin || isOrgAdmin) && (
                                                <button
                                                    type="button"
                                                    onClick={() => setActiveTabByOrg(prev => ({ ...prev, [org.id]: 'members' }))}
                                                    className={`px-4 py-3 text-xs sm:text-sm font-semibold border-b-2 transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
                                                        currentTab === 'members'
                                                            ? 'border-purple-500 text-purple-300 bg-purple-950/25 rounded-t-lg'
                                                            : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 rounded-t-lg'
                                                    }`}
                                                >
                                                    <Users size={16} />
                                                    <span>Gestion des Membres & Rôles</span>
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Contenu de l'onglet actif */}
                                    <div className="p-5 sm:p-6 bg-slate-950">
                                        {currentTab === 'members' && (isSuperAdmin || isOrgAdmin) ? (
                                            <AdminView
                                                orgOverride={org}
                                                isOrgAdminOverride={true}
                                                mode="org"
                                                hideComptasTab={true}
                                                onChanged={() => fetchData(true)}
                                            />
                                        ) : (
                                            <div className={`grid grid-cols-1 gap-6 items-start ${hasCaissierAccess ? 'lg:grid-cols-12' : ''}`}>
                                                {/* Colonne de gauche : Création rapide d'une comptabilité (pour Admin / Caissier) */}
                                                {hasCaissierAccess && (
                                                    <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
                                                        <h3 className="font-semibold text-white text-sm sm:text-base mb-3 flex items-center gap-2">
                                                            <Plus size={17} className="text-blue-400" />
                                                            Nouvelle Comptabilité
                                                        </h3>
                                                        <form onSubmit={(e) => handleCreateCompta(e, org.id)} className="space-y-3">
                                                            <div>
                                                                <label className="block text-xs font-semibold text-slate-400 mb-1">
                                                                    Nom (ex: Louveteaux 26-27, Groupe 25-26) *
                                                                </label>
                                                                <input
                                                                    type="text"
                                                                    placeholder="Ex: Mondisé 26-27"
                                                                    value={newComptaNameByOrg[org.id] || ''}
                                                                    onChange={e => setNewComptaNameByOrg(prev => ({ ...prev, [org.id]: e.target.value }))}
                                                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                                                                    required
                                                                />
                                                            </div>
                                                            <div>
                                                                <label className="block text-xs font-semibold text-slate-400 mb-1">
                                                                    Description (optionnelle)
                                                                </label>
                                                                <input
                                                                    type="text"
                                                                    placeholder="Description de la section..."
                                                                    value={newComptaDescByOrg[org.id] || ''}
                                                                    onChange={e => setNewComptaDescByOrg(prev => ({ ...prev, [org.id]: e.target.value }))}
                                                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                                                                />
                                                            </div>
                                                            <button
                                                                type="submit"
                                                                disabled={isCreatingCompta === org.id || !(newComptaNameByOrg[org.id] || '').trim()}
                                                                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2.5 rounded-lg flex justify-center items-center gap-2 text-xs sm:text-sm font-semibold transition-colors cursor-pointer shadow-md shadow-blue-950/40"
                                                            >
                                                                {isCreatingCompta === org.id ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                                                                Créer la comptabilité
                                                            </button>
                                                        </form>
                                                    </div>
                                                )}

                                                {/* Colonne de droite : Navigation vers les comptabilités + Actions (Renommer, Archiver, Supprimer) */}
                                                <div className={hasCaissierAccess ? 'lg:col-span-8 space-y-3' : 'space-y-3'}>
                                                    <div className="flex items-center justify-between px-1">
                                                        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                                                            Cliquez sur une comptabilité pour l'ouvrir ({comptasToShow.length})
                                                        </h3>
                                                        {archivedComptas.length > 0 && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setShowArchived(prev => ({ ...prev, [org.id]: !prev[org.id] }))}
                                                                className="text-xs text-blue-400 hover:text-blue-300 underline transition-colors cursor-pointer"
                                                            >
                                                                {showArchived[org.id] ? "Masquer les archives" : `Voir les archives (${archivedComptas.length})`}
                                                            </button>
                                                        )}
                                                    </div>

                                                    {allComptas.length === 0 ? (
                                                        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500 italic">
                                                            Aucune comptabilité trouvée dans cette association.
                                                        </div>
                                                    ) : (
                                                        <div className="grid grid-cols-1 gap-2.5">
                                                            {comptasToShow.map((item, idx) => {
                                                                const isCaissierOrAdmin = isSuperAdmin || isOrgAdmin || item.role === 'caissier' || item.role === 'comptable' || item.role === 'admin';
                                                                const canDelete = isSuperAdmin || isOrgAdmin;

                                                                return (
                                                                    <div
                                                                        key={`${item.compta.id}-${idx}`}
                                                                        onClick={() => handleSelectCompta(org, item)}
                                                                        className={`flex items-center justify-between gap-3 px-4 py-3.5 rounded-xl border transition-all cursor-pointer group ${
                                                                            item.compta.isArchived
                                                                                ? 'bg-slate-900/40 border-slate-800/80 hover:border-slate-700'
                                                                                : 'bg-slate-900 border-slate-800 hover:bg-blue-950/25 hover:border-blue-700/60 shadow-sm'
                                                                        }`}
                                                                    >
                                                                        <div className="flex items-center gap-3.5 min-w-0 flex-1">
                                                                            <div className={`p-2.5 rounded-lg transition-colors shrink-0 ${
                                                                                item.compta.isArchived
                                                                                    ? 'bg-slate-800/50 text-slate-500'
                                                                                    : 'bg-blue-950/60 border border-blue-800/40 text-blue-400 group-hover:bg-blue-600 group-hover:text-white'
                                                                            }`}>
                                                                                <Book size={18} />
                                                                            </div>

                                                                            <div className="min-w-0 flex-1">
                                                                                <div className="flex flex-wrap items-center gap-2">
                                                                                    <span className={`font-bold text-sm sm:text-base transition-colors truncate ${
                                                                                        item.compta.isArchived ? 'text-slate-500 line-through' : 'text-white group-hover:text-blue-300'
                                                                                    }`}>
                                                                                        {item.compta.name}
                                                                                    </span>
                                                                                    <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                                                                                        item.role === 'admin'
                                                                                            ? 'bg-purple-900/30 text-purple-300 border-purple-800/50'
                                                                                            : (item.role === 'caissier' || item.role === 'comptable')
                                                                                                ? 'bg-emerald-900/30 text-emerald-300 border-emerald-800/50'
                                                                                                : item.role === 'verificateur'
                                                                                                    ? 'bg-amber-900/30 text-amber-300 border-amber-800/50'
                                                                                                    : 'bg-blue-900/30 text-blue-300 border-blue-800/50'
                                                                                    }`}>
                                                                                        {item.role === 'admin'
                                                                                            ? 'Admin'
                                                                                            : (item.role === 'caissier' || item.role === 'comptable')
                                                                                                ? 'Caissier'
                                                                                                : item.role === 'verificateur'
                                                                                                    ? 'Vérificateur'
                                                                                                    : 'Lecteur'}
                                                                                    </span>
                                                                                    {item.compta.isArchived && (
                                                                                        <span className="text-[10px] uppercase tracking-wider bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                                                                                            Archivé
                                                                                        </span>
                                                                                    )}
                                                                                </div>
                                                                                {item.compta.description && (
                                                                                    <p className="text-xs text-slate-400 truncate mt-0.5">
                                                                                        {item.compta.description}
                                                                                    </p>
                                                                                )}
                                                                            </div>
                                                                        </div>

                                                                        {/* Actions alignées horizontalement : Renommer, Archiver/Clôturer, Supprimer, Ouvrir */}
                                                                        <div className="flex items-center gap-1 shrink-0">
                                                                            {isCaissierOrAdmin && (
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => handleOpenRename(e, org.id, item.compta)}
                                                                                    className="p-2 text-slate-400 hover:text-blue-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                                                                                    title="Renommer la comptabilité"
                                                                                >
                                                                                    <Edit2 size={15} />
                                                                                </button>
                                                                            )}
                                                                            {isCaissierOrAdmin && (
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => handleOpenClosingModal(e, org, item.compta)}
                                                                                    className="p-2 text-slate-400 hover:text-amber-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                                                                                    title={item.compta.isArchived ? "Désarchiver" : "Clôturer l'exercice / Archiver"}
                                                                                >
                                                                                    {item.compta.isArchived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                                                                                </button>
                                                                            )}
                                                                            {canDelete && (
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={(e) => handleDelete(e, org.id, item.compta.id)}
                                                                                    className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                                                                                    title="Supprimer définitivement"
                                                                                >
                                                                                    <Trash2 size={16} />
                                                                                </button>
                                                                            )}
                                                                            <div className="pl-2 ml-1 border-l border-slate-800 flex items-center gap-1 text-xs font-semibold text-slate-400 group-hover:text-blue-400">
                                                                                <span className="hidden sm:inline">Ouvrir</span>
                                                                                <ArrowRight size={16} className="transform transition-transform group-hover:translate-x-1" />
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                
                {isSuperAdmin && (
                    <div className="mt-8 text-center">
                        <button 
                            onClick={() => { window.location.hash = '#superadmin'; }}
                            className="text-sm text-purple-400 hover:text-purple-300 hover:underline transition-colors font-medium"
                        >
                            Accéder au panneau Super Admin
                        </button>
                    </div>
                )}
            </div>

            {/* MODAL: RENOMMER UNE COMPTABILITÉ */}
            {renamingTarget && (
                <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                        <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-800">
                            <h3 className="font-bold text-white text-lg flex items-center gap-2">
                                <Edit2 size={18} className="text-blue-400" />
                                Renommer la comptabilité
                            </h3>
                            <button
                                onClick={() => setRenamingTarget(null)}
                                className="text-slate-500 hover:text-white p-1"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <form onSubmit={handleSaveRename} className="space-y-4">
                            <div>
                                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                                    Nom de la comptabilité *
                                </label>
                                <input
                                    type="text"
                                    value={renameNameInput}
                                    onChange={(e) => setRenameNameInput(e.target.value)}
                                    placeholder="Ex: Groupe 25/26"
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                                    autoFocus
                                    required
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1.5">
                                    Description (optionnelle)
                                </label>
                                <textarea
                                    value={renameDescInput}
                                    onChange={(e) => setRenameDescInput(e.target.value)}
                                    placeholder="Description de la section ou de l'exercice..."
                                    rows={2}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
                                />
                            </div>

                            <div className="flex justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={() => setRenamingTarget(null)}
                                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors"
                                >
                                    Annuler
                                </button>
                                <button
                                    type="submit"
                                    disabled={isSavingRename || !renameNameInput.trim()}
                                    className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold flex items-center gap-2 transition-colors"
                                >
                                    {isSavingRename ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                                    Enregistrer
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* MODAL: CLÔTURE D'EXERCICE & ITÉRATION VERS LA NOUVELLE ANNÉE */}
            {closingTarget && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-5 sm:p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200 my-auto">
                        <div className="flex justify-between items-start mb-4 pb-3 border-b border-slate-800">
                            <div>
                                <h3 className="font-bold text-white text-lg flex items-center gap-2">
                                    <Archive size={20} className="text-amber-400 shrink-0" />
                                    Clôturer « {closingTarget.compta.name} »
                                </h3>
                                <p className="text-xs text-slate-400 mt-1">
                                    Archive l'exercice actuel et crée automatiquement le nouvel exercice avec report du solde final.
                                </p>
                            </div>
                            <button
                                onClick={() => setClosingTarget(null)}
                                className="text-slate-500 hover:text-white p-1"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <form onSubmit={handleConfirmRollover} className="space-y-4">
                            {/* Résumé des soldes */}
                            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
                                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                                    Bilan de fin d'exercice ({closingTarget.compta.name})
                                </div>
                                {isLoadingClosingSummary ? (
                                    <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                                        <Loader2 size={16} className="animate-spin text-blue-500" />
                                        Calcul du solde final en cours...
                                    </div>
                                ) : closingSummary ? (
                                    <div className="space-y-1.5 text-xs">
                                        <div className="flex justify-between text-slate-400">
                                            <span>Solde d'ouverture initial :</span>
                                            <span className="font-mono text-slate-200">CHF {closingSummary.openingBalance.toFixed(2)}</span>
                                        </div>
                                        <div className="flex justify-between text-slate-400">
                                            <span>Mouvements ({closingSummary.transactionsCount} écritures) :</span>
                                            <span className={`font-mono ${closingSummary.totalMovements >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {closingSummary.totalMovements >= 0 ? '+' : ''}CHF {closingSummary.totalMovements.toFixed(2)}
                                            </span>
                                        </div>
                                        <div className="pt-2 border-t border-slate-800 flex justify-between items-center font-bold text-sm">
                                            <span className="text-amber-400">Solde final à reporter :</span>
                                            <span className="font-mono text-white">CHF {closingSummary.closingBalance.toFixed(2)}</span>
                                        </div>
                                    </div>
                                ) : null}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1.5">
                                        <Calendar size={13} className="text-blue-400" />
                                        Date de clôture *
                                    </label>
                                    <input
                                        type="date"
                                        value={closingDateInput}
                                        onChange={(e) => setClosingDateInput(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                                        required
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                                        Nouvelles années (ex: 26/27) *
                                    </label>
                                    <input
                                        type="text"
                                        value={closingPeriodInput}
                                        onChange={(e) => handlePeriodChangeInModal(e.target.value)}
                                        placeholder="Ex: 26/27"
                                        className="w-full bg-slate-950 border border-blue-500/60 rounded-lg p-2.5 text-white text-sm font-semibold focus:outline-none focus:border-blue-400"
                                        required
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                                        Nom de la nouvelle comptabilité *
                                    </label>
                                    <input
                                        type="text"
                                        value={closingNewNameInput}
                                        onChange={(e) => {
                                            setClosingNewNameInput(e.target.value);
                                            setClosingCustomNameEdited(true);
                                        }}
                                        placeholder="Ex: Groupe 26/27"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:outline-none focus:border-blue-500"
                                        required
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                                        Solde d'ouverture reporté (CHF)
                                    </label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={closingCarryOverBalance}
                                        onChange={(e) => setClosingCarryOverBalance(parseFloat(e.target.value) || 0)}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-emerald-400 font-mono text-sm focus:outline-none focus:border-emerald-500"
                                    />
                                </div>
                            </div>

                            <div className="pt-2 space-y-2.5">
                                <button
                                    type="submit"
                                    disabled={isSubmittingClose || isLoadingClosingSummary || !closingNewNameInput.trim()}
                                    className="w-full py-2.5 px-4 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 disabled:opacity-50 text-white font-bold rounded-xl shadow-lg shadow-amber-900/30 flex items-center justify-center gap-2 text-sm transition-all cursor-pointer"
                                >
                                    {isSubmittingClose ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle size={18} />}
                                    Clôturer & Créer « {closingNewNameInput || 'Nouvel Exercice'} »
                                </button>

                                <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 gap-2">
                                    <button
                                        type="button"
                                        onClick={handleArchiveOnly}
                                        disabled={isSubmittingClose}
                                        className="text-xs text-slate-400 hover:text-amber-300 underline transition-colors"
                                    >
                                        Archiver simplement sans créer de nouvelle année
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setClosingTarget(null)}
                                        className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition-colors"
                                    >
                                        Annuler
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
