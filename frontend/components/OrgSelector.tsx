import React, { useState, useEffect } from 'react';
import { useAuthContext, useOrgContext, useComptaContext } from '../contexts/AppContext';
import { Organization, Comptabilite } from '../types/rbac';
import { listAllOrganizations, getUserOrganizations, listComptabilites } from '../services/organizationService';
import { getUserComptabilites } from '../services/userService';
import { Building2, Book, Plus, ArrowRight, Loader2, LogOut, Trash2, Archive, ArchiveRestore, Database, Sparkles, Shield } from 'lucide-react';
import { logout } from '../services/authService';
import { checkLegacyData, LegacyDataSummary, connectCurrentCompta, markLegacyMigrationDone } from '../services/migrationService';
import { createComptabilite, deleteComptabilite, toggleArchiveComptabilite } from '../services/organizationService';
import { UnauthorizedView } from './UnauthorizedView';

export const OrgSelector: React.FC = () => {
    const { user, isSuperAdmin } = useAuthContext();
    const { setSelectedOrg, setOrgRole } = useOrgContext();
    const { setSelectedCompta, setComptaRole } = useComptaContext();
    
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [comptasByOrg, setComptasByOrg] = useState<Record<string, Array<{compta: Comptabilite, role: any}>>>({});
    const [loading, setLoading] = useState(true);
    const [legacySummary, setLegacySummary] = useState<LegacyDataSummary | null>(null);
    const [hasLegacyData, setHasLegacyData] = useState(false);
    const [isConnectingLegacy, setIsConnectingLegacy] = useState(false);
    const [isCreatingCompta, setIsCreatingCompta] = useState<string | null>(null); // orgId
    const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});

    const fetchData = async () => {
        if (!user) return;
        setLoading(true);
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
            setOrganizations(orgs);

            // Fetch Comptas and roles defined in Firebase
            const userComptas = await getUserComptabilites(user.uid, user.email || undefined);
            
            const userRoleByComptaId: Record<string, any> = {};
            userComptas.forEach(uc => {
                userRoleByComptaId[uc.compta.id] = uc.role;
            });

            const byOrg: Record<string, Array<{compta: Comptabilite, role: any}>> = {};
            
            if (isSuperAdmin) {
                // SuperAdmin a accès à TOUTES les comptas
                for (const org of orgs) {
                    const allComptas = await listComptabilites(org.id);
                    byOrg[org.id] = allComptas.map(c => ({ 
                        compta: c, 
                        role: userRoleByComptaId[c.id] || 'caissier' 
                    }));
                }
            } else {
                // Admin d'une organisation a accès à toutes les comptabilités de son organisation
                for (const org of orgs) {
                    const isOrgAdmin = org.createdBy === user.uid || (user.email && org.adminEmail && org.adminEmail.trim().toLowerCase() === user.email.trim().toLowerCase());
                    if (isOrgAdmin) {
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
            
            setComptasByOrg(byOrg);
        } catch (err) {
            console.error("Error fetching orgs/comptas:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, [user, isSuperAdmin]);

    const isOrgAdminOf = (org: Organization) => {
        if (isSuperAdmin) return true;
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

    const handleCreateCompta = async (orgId: string) => {
        if (!user) return;
        const name = prompt("Nom de la nouvelle comptabilité ? (ex: Exercice 2024)");
        if (!name) return;

        setIsCreatingCompta(orgId);
        try {
            await createComptabilite(orgId, { 
                name,
                description: '',
                createdBy: user.uid,
                fiscalYearStart: '',
                fiscalYearEnd: '',
                currency: 'CHF'
            }, user.uid);
            window.location.reload();
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
                window.location.reload();
            } catch (err) {
                console.error(err);
                alert("Erreur lors de la suppression.");
            }
        }
    };

    const handleToggleArchive = async (e: React.MouseEvent, orgId: string, comptaId: string, isArchived: boolean) => {
        e.stopPropagation();
        try {
            await toggleArchiveComptabilite(orgId, comptaId, !isArchived);
            window.location.reload();
        } catch (err) {
            console.error(err);
            alert("Erreur lors de l'archivage/désarchivage.");
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
        organizations.some(org => isOrgAdminOf(org)) || 
        Object.values(comptasByOrg).some(list => list.length > 0) ||
        hasLegacyData;

    if (!hasAnyAccess) {
        return (
            <UnauthorizedView 
                email={user?.email || ''} 
                onRefresh={fetchData} 
                isRefreshing={loading} 
            />
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center p-8">
            <div className="w-full max-w-4xl">
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-white tracking-tight mb-2">
                            <span className="text-blue-500">Asso</span>Compta AI
                        </h1>
                        <p className="text-slate-400">Sélectionnez un espace de travail pour continuer</p>
                    </div>
                    <div className="flex items-center gap-3">
                        {isSuperAdmin && (
                            <button 
                                onClick={() => { window.location.hash = '#superadmin'; }}
                                className="flex items-center gap-2 px-3.5 py-2 bg-purple-950/60 hover:bg-purple-900/80 text-purple-200 border border-purple-800/60 rounded-lg text-xs font-semibold transition-all cursor-pointer shadow-md shadow-purple-950/40"
                            >
                                <Shield size={14} className="text-purple-400" />
                                Panneau Super Admin (Créer des associations)
                            </button>
                        )}
                        <button 
                            onClick={async () => { await logout(); window.location.href = '/'; }}
                            className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg transition-colors border border-slate-800"
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
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {organizations.map(org => {
                            const isOrgAdmin = isOrgAdminOf(org);
                            const allComptas = comptasByOrg[org.id] || [];
                            const activeComptas = allComptas.filter(c => !c.compta.isArchived);
                            const archivedComptas = allComptas.filter(c => c.compta.isArchived);
                            const comptasToShow = showArchived[org.id] ? allComptas : activeComptas;
                            
                            return (
                                <div key={org.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg shadow-black/20">
                                    <div className="p-6 border-b border-slate-800 bg-slate-900/50">
                                        <div className="flex items-center justify-between mb-2">
                                            <h2 className="text-xl font-bold text-white flex items-center gap-2">
                                                <Building2 size={20} className="text-blue-500" />
                                                {org.name}
                                            </h2>
                                            {isSuperAdmin ? (
                                                <span className="px-2 py-1 bg-purple-900/30 text-purple-400 border border-purple-800/50 rounded text-xs font-bold uppercase tracking-wider">Super Admin</span>
                                            ) : isOrgAdmin ? (
                                                <span className="px-2 py-1 bg-blue-900/30 text-blue-400 border border-blue-800/50 rounded text-xs font-bold uppercase tracking-wider">Admin Org</span>
                                            ) : null}
                                        </div>
                                        <p className="text-sm text-slate-400">{org.description || "Aucune description"}</p>
                                    </div>
                                    
                                    <div className="p-4 bg-slate-950">
                                        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3 px-2">Comptabilités accessibles</h3>
                                        {allComptas.length === 0 ? (
                                            <p className="text-sm text-slate-600 italic px-2 pb-2">Aucune comptabilité trouvée.</p>
                                        ) : (
                                            <div className="space-y-2">
                                                {comptasToShow.map((item, idx) => (
                                                    <div key={`${item.compta.id}-${idx}`} className="flex items-center gap-2">
                                                        <button
                                                            onClick={() => handleSelectCompta(org, item)}
                                                            className={`flex-1 flex items-center justify-between p-3 rounded-lg border transition-all group ${
                                                                item.compta.isArchived 
                                                                    ? 'bg-slate-900/50 border-slate-800 hover:border-slate-700' 
                                                                    : 'hover:bg-blue-900/20 hover:border-blue-800/50 border-transparent'
                                                            }`}
                                                        >
                                                            <div className="flex items-center gap-3">
                                                                <div className={`p-2 rounded-lg transition-colors ${
                                                                    item.compta.isArchived 
                                                                        ? 'bg-slate-800/50 text-slate-500' 
                                                                        : 'bg-slate-800 group-hover:bg-blue-900/50 text-slate-400 group-hover:text-blue-400'
                                                                }`}>
                                                                    <Book size={16} />
                                                                </div>
                                                                <div className="text-left">
                                                                    <div className={`font-medium transition-colors ${
                                                                        item.compta.isArchived ? 'text-slate-500 line-through' : 'text-slate-200 group-hover:text-blue-300'
                                                                    }`}>
                                                                        {item.compta.name}
                                                                        {item.compta.isArchived && <span className="ml-2 text-[10px] uppercase tracking-wider bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">Archivé</span>}
                                                                    </div>
                                                                    <div className="flex items-center gap-1.5 mt-1">
                                                                        <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded border ${
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
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <ArrowRight size={16} className={`transform transition-all ${
                                                                item.compta.isArchived ? 'text-slate-600' : 'text-slate-600 group-hover:text-blue-400 group-hover:translate-x-1'
                                                            }`} />
                                                        </button>
                                                        
                                                        {(() => {
                                                            const isCaissierOrAdmin = isSuperAdmin || isOrgAdmin || item.role === 'caissier' || item.role === 'comptable' || item.role === 'admin';
                                                            const canDelete = isSuperAdmin || isOrgAdmin;
                                                            if (!isCaissierOrAdmin && !canDelete) return null;
                                                            return (
                                                                <div className="flex flex-col gap-1">
                                                                    {isCaissierOrAdmin && (
                                                                        <button
                                                                            onClick={(e) => handleToggleArchive(e, org.id, item.compta.id, !!item.compta.isArchived)}
                                                                            className="p-1.5 text-slate-500 hover:text-amber-400 hover:bg-slate-800 rounded transition-colors"
                                                                            title={item.compta.isArchived ? "Désarchiver" : "Archiver"}
                                                                        >
                                                                            {item.compta.isArchived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                                                                        </button>
                                                                    )}
                                                                    {canDelete && (
                                                                        <button
                                                                            onClick={(e) => handleDelete(e, org.id, item.compta.id)}
                                                                            className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded transition-colors"
                                                                            title="Supprimer définitivement"
                                                                        >
                                                                            <Trash2 size={16} />
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            );
                                                        })()}
                                                    </div>
                                                ))}
                                                {archivedComptas.length > 0 && (
                                                    <div className="mt-2 text-center">
                                                        <button 
                                                            onClick={() => setShowArchived(prev => ({...prev, [org.id]: !prev[org.id]}))}
                                                            className="text-xs text-slate-500 hover:text-slate-400 underline transition-colors pt-2"
                                                        >
                                                            {showArchived[org.id] ? "Masquer les archives" : `Voir les archives (${archivedComptas.length})`}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        
                                        {(() => {
                                            const hasCaissierAccess = isSuperAdmin || isOrgAdmin || allComptas.some(c => c.role === 'caissier' || c.role === 'comptable' || c.role === 'admin');
                                            if (!hasCaissierAccess && !isSuperAdmin && !isOrgAdmin) return null;

                                            return (
                                                <div className="mt-4 pt-4 border-t border-slate-800/50 flex flex-col gap-2 px-2">
                                                    {hasCaissierAccess && (
                                                        <button 
                                                            onClick={() => handleCreateCompta(org.id)}
                                                            disabled={isCreatingCompta === org.id}
                                                            className="flex items-center justify-center gap-2 w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors"
                                                        >
                                                            {isCreatingCompta === org.id ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                                                            Nouvelle Comptabilité
                                                        </button>
                                                    )}

                                                    {(isSuperAdmin || isOrgAdmin) && (
                                                        <button 
                                                            onClick={() => {
                                                                setSelectedOrg(org);
                                                                setOrgRole(isOrgAdmin ? 'admin' : 'member');
                                                                const firstCompta = allComptas[0]?.compta || null;
                                                                if (firstCompta) setSelectedCompta(firstCompta);
                                                                window.location.hash = '#admin';
                                                            }}
                                                            className="flex items-center justify-center gap-2 w-full py-2 bg-purple-950/40 hover:bg-purple-900/60 text-purple-300 border border-purple-800/50 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                                                        >
                                                            <Shield size={16} className="text-purple-400" />
                                                            Gérer les membres & rôles
                                                        </button>
                                                    )}
                                                    
                                                    {hasLegacyData && (isSuperAdmin || isOrgAdmin) && (
                                                        <button 
                                                            onClick={() => handleAutoConnectLegacy(org.id)}
                                                            disabled={isConnectingLegacy}
                                                            className="flex items-center justify-center gap-2 w-full py-2 bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 border border-indigo-800/50 rounded-lg text-sm font-medium transition-colors cursor-pointer"
                                                        >
                                                            {isConnectingLegacy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={18} />}
                                                            Connecter ma compta V1 ici
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })()}
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
        </div>
    );
};
