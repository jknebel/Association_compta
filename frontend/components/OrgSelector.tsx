import React, { useState, useEffect } from 'react';
import { useAuthContext, useOrgContext, useComptaContext } from '../contexts/AppContext';
import { Organization, Comptabilite } from '../types/rbac';
import { listAllOrganizations, getUserOrganizations, listComptabilites } from '../services/organizationService';
import { getUserComptabilites } from '../services/userService';
import { Building2, Book, Plus, ArrowRight, Loader2, LogOut, Trash2, Archive, ArchiveRestore } from 'lucide-react';
import { logout } from '../services/authService';
import { checkHasLegacyData, migrateLegacyDataToOrg } from '../services/migrationService';
import { createComptabilite, deleteComptabilite, toggleArchiveComptabilite } from '../services/organizationService';
export const OrgSelector: React.FC = () => {
    const { user, isSuperAdmin } = useAuthContext();
    const { setSelectedOrg, setOrgRole } = useOrgContext();
    const { setSelectedCompta, setComptaRole } = useComptaContext();
    
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [comptasByOrg, setComptasByOrg] = useState<Record<string, Array<{compta: Comptabilite, role: any}>>>({});
    const [loading, setLoading] = useState(true);
    const [hasLegacyData, setHasLegacyData] = useState(false);
    const [isMigrating, setIsMigrating] = useState(false);
    const [isCreatingCompta, setIsCreatingCompta] = useState<string | null>(null); // orgId
    const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});

    useEffect(() => {
        const fetchData = async () => {
            if (!user) return;
            try {
                // Check legacy data
                const legacy = await checkHasLegacyData(user.uid);
                setHasLegacyData(legacy);

                // Fetch Organizations
                let orgs: Organization[] = [];
                if (isSuperAdmin) {
                    orgs = await listAllOrganizations();
                } else {
                    orgs = await getUserOrganizations(user.uid);
                }
                setOrganizations(orgs);

                // Fetch Comptas
                const userComptas = await getUserComptabilites(user.uid);
                
                const byOrg: Record<string, Array<{compta: Comptabilite, role: any}>> = {};
                
                if (isSuperAdmin) {
                    // SuperAdmin a accès à TOUTES les comptas
                    for (const org of orgs) {
                        const allComptas = await listComptabilites(org.id);
                        byOrg[org.id] = allComptas.map(c => ({ compta: c, role: 'admin' }));
                    }
                } else {
                    // Normal user
                    userComptas.forEach(uc => {
                        if (!byOrg[uc.orgId]) byOrg[uc.orgId] = [];
                        byOrg[uc.orgId].push({ compta: uc.compta, role: uc.role });
                    });
                    
                    // Admin d'une org a accès à toutes les comptas de son org
                    for (const org of orgs) {
                        // Check if admin of this org (we fetch this from user profile or we trust that getUserOrganizations returns orgs they are member of)
                        // Actually, if we want to be clean we should check `userProfile.organizations[org.id]?.role === 'admin'`
                        // but let's just fetch all comptas for orgs where they are admin
                        // To keep it simple, if they are admin, they can see all comptas in AdminView.
                    }
                }
                
                setComptasByOrg(byOrg);
            } catch (err) {
                console.error("Error fetching orgs/comptas:", err);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [user, isSuperAdmin]);

    const handleSelectCompta = (org: Organization, comptaData: {compta: Comptabilite, role: any}) => {
        setSelectedOrg(org);
        setOrgRole('member' as any); // fallback
        
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

    const handleMigrate = async (orgId: string) => {
        if (!user) return;
        if (!window.confirm("Voulez-vous copier toutes vos anciennes données dans cette organisation ?")) return;
        
        setIsMigrating(true);
        try {
            const name = prompt("Nom de la comptabilité pour vos données importées ?", "Comptabilité principale");
            if (!name) {
                setIsMigrating(false);
                return;
            }
            await migrateLegacyDataToOrg(user.uid, orgId, name);
            window.location.reload();
        } catch (e) {
            console.error(e);
            alert("Erreur lors de la migration.");
            setIsMigrating(false);
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

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center p-8">
            <div className="w-full max-w-4xl">
                <div className="flex justify-between items-center mb-12">
                    <div>
                        <h1 className="text-3xl font-bold text-white tracking-tight mb-2">
                            <span className="text-blue-500">Asso</span>Compta AI
                        </h1>
                        <p className="text-slate-400">Sélectionnez un espace de travail pour continuer</p>
                    </div>
                    <button 
                        onClick={async () => { await logout(); window.location.href = '/'; }}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded-lg transition-colors border border-slate-800"
                    >
                        <LogOut size={16} />
                        Déconnexion
                    </button>
                </div>

                {organizations.length === 0 ? (
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center">
                        <Building2 size={48} className="mx-auto text-slate-600 mb-4" />
                        <h2 className="text-xl font-semibold text-white mb-2">Aucune organisation</h2>
                        <p className="text-slate-400 mb-6 max-w-md mx-auto">
                            Vous n'êtes membre d'aucune organisation pour le moment. 
                            Veuillez demander à un administrateur de vous inviter.
                        </p>
                        {isSuperAdmin && (
                            <button 
                                onClick={() => { window.location.href = '/#superadmin'; window.location.reload(); }}
                                className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 rounded-lg transition-colors font-medium inline-flex items-center gap-2"
                            >
                                <Plus size={18} />
                                Créer une organisation
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {organizations.map(org => {
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
                                            {isSuperAdmin && <span className="px-2 py-1 bg-purple-900/30 text-purple-400 border border-purple-800/50 rounded text-xs font-bold uppercase tracking-wider">Admin</span>}
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
                                                                    <div className="text-xs text-slate-500">
                                                                        Rôle: <span className="text-slate-400">{item.role}</span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <ArrowRight size={16} className={`transform transition-all ${
                                                                item.compta.isArchived ? 'text-slate-600' : 'text-slate-600 group-hover:text-blue-400 group-hover:translate-x-1'
                                                            }`} />
                                                        </button>
                                                        
                                                        {isSuperAdmin && (
                                                            <div className="flex flex-col gap-1">
                                                                <button
                                                                    onClick={(e) => handleToggleArchive(e, org.id, item.compta.id, !!item.compta.isArchived)}
                                                                    className="p-1.5 text-slate-500 hover:text-amber-400 hover:bg-slate-800 rounded transition-colors"
                                                                    title={item.compta.isArchived ? "Désarchiver" : "Archiver"}
                                                                >
                                                                    {item.compta.isArchived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                                                                </button>
                                                                <button
                                                                    onClick={(e) => handleDelete(e, org.id, item.compta.id)}
                                                                    className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded transition-colors"
                                                                    title="Supprimer définitivement"
                                                                >
                                                                    <Trash2 size={16} />
                                                                </button>
                                                            </div>
                                                        )}
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
                                        
                                        {isSuperAdmin && (
                                            <div className="mt-4 pt-4 border-t border-slate-800/50 flex flex-col gap-2 px-2">
                                                <button 
                                                    onClick={() => handleCreateCompta(org.id)}
                                                    disabled={isCreatingCompta === org.id}
                                                    className="flex items-center justify-center gap-2 w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors"
                                                >
                                                    {isCreatingCompta === org.id ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                                                    Nouvelle Comptabilité
                                                </button>
                                                
                                                {hasLegacyData && (
                                                    <button 
                                                        onClick={() => handleMigrate(org.id)}
                                                        disabled={isMigrating}
                                                        className="flex items-center justify-center gap-2 w-full py-2 bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-300 border border-indigo-800/50 rounded-lg text-sm font-medium transition-colors"
                                                    >
                                                        {isMigrating ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                                                        Migrer mes données perso ici
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                
                {isSuperAdmin && organizations.length > 0 && (
                    <div className="mt-8 text-center">
                        <button 
                            onClick={() => { window.location.href = '/#superadmin'; window.location.reload(); }}
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
