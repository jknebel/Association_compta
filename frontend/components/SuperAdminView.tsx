import React, { useState, useEffect } from 'react';
import { listAllOrganizations, createOrganization, deleteOrganization } from '../services/organizationService';
import { Organization } from '../types/rbac';
import { ShieldCheck, Building2, Trash2, Plus, Loader2, ArrowLeft } from 'lucide-react';
import { useAuthContext } from '../contexts/AppContext';

export const SuperAdminView: React.FC = () => {
    const { user, isSuperAdmin } = useAuthContext();
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [loading, setLoading] = useState(true);
    
    const [newOrgName, setNewOrgName] = useState('');
    const [newOrgDesc, setNewOrgDesc] = useState('');
    const [isCreating, setIsCreating] = useState(false);

    const fetchOrgs = async () => {
        setLoading(true);
        try {
            const orgs = await listAllOrganizations();
            setOrganizations(orgs);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isSuperAdmin) {
            fetchOrgs();
        }
    }, [isSuperAdmin]);

    const handleCreateOrg = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user || !newOrgName.trim()) return;
        
        setIsCreating(true);
        try {
            await createOrganization(newOrgName, newOrgDesc, user.uid);
            setNewOrgName('');
            setNewOrgDesc('');
            await fetchOrgs();
        } catch (error) {
            console.error("Failed to create org:", error);
            alert("Erreur lors de la création de l'organisation");
        } finally {
            setIsCreating(false);
        }
    };

    const handleDeleteOrg = async (orgId: string) => {
        if (!window.confirm("Êtes-vous sûr de vouloir supprimer cette organisation ? Cette action est irréversible.")) {
            return;
        }
        
        try {
            await deleteOrganization(orgId);
            await fetchOrgs();
        } catch (error) {
            console.error("Failed to delete org:", error);
            alert("Erreur lors de la suppression de l'organisation");
        }
    };

    if (!isSuperAdmin) {
        return (
            <div className="p-8 text-center text-red-500">
                Accès refusé. Vous n'avez pas les droits Super Admin.
            </div>
        );
    }

    return (
        <div className="p-8 max-w-5xl mx-auto">
            <header className="mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
                        <ShieldCheck className="text-purple-500" size={28} />
                        Panneau Super Admin
                    </h2>
                    <p className="text-slate-400 mt-1">Gérez toutes les organisations de la plateforme.</p>
                </div>
                <button 
                    onClick={() => { window.location.href = '/'; window.location.reload(); }}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors border border-slate-700 shrink-0"
                >
                    <ArrowLeft size={16} />
                    Retour aux espaces
                </button>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Create Org Form */}
                <div className="lg:col-span-1">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-sm">
                        <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                            <Plus size={18} className="text-blue-500" />
                            Nouvelle Organisation
                        </h3>
                        <form onSubmit={handleCreateOrg} className="space-y-4">
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Nom de l'organisation</label>
                                <input
                                    type="text"
                                    value={newOrgName}
                                    onChange={(e) => setNewOrgName(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-white text-sm focus:outline-none focus:border-blue-500"
                                    required
                                    placeholder="Ex: Groupe TDGL"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 mb-1">Description</label>
                                <textarea
                                    value={newOrgDesc}
                                    onChange={(e) => setNewOrgDesc(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2 px-3 text-white text-sm focus:outline-none focus:border-blue-500 min-h-[80px]"
                                    placeholder="Description courte..."
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={isCreating || !newOrgName.trim()}
                                className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2 text-sm font-semibold transition-colors flex justify-center items-center gap-2 disabled:opacity-50"
                            >
                                {isCreating ? <Loader2 size={16} className="animate-spin" /> : "Créer l'organisation"}
                            </button>
                        </form>
                    </div>
                </div>

                {/* List Orgs */}
                <div className="lg:col-span-2">
                    <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-sm overflow-hidden">
                        <div className="p-4 border-b border-slate-800 bg-slate-950 flex justify-between items-center">
                            <h3 className="font-semibold text-white">Organisations existantes</h3>
                            <span className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded-full">
                                {organizations.length} au total
                            </span>
                        </div>
                        
                        {loading ? (
                            <div className="p-12 flex justify-center text-slate-500">
                                <Loader2 size={24} className="animate-spin" />
                            </div>
                        ) : organizations.length === 0 ? (
                            <div className="p-12 text-center text-slate-500 italic">
                                Aucune organisation n'a été créée pour le moment.
                            </div>
                        ) : (
                            <div className="divide-y divide-slate-800">
                                {organizations.map(org => (
                                    <div key={org.id} className="p-4 flex items-center justify-between hover:bg-slate-800/50 transition-colors">
                                        <div className="flex items-start gap-3">
                                            <div className="bg-blue-900/30 p-2 rounded-lg text-blue-500 border border-blue-800/50">
                                                <Building2 size={20} />
                                            </div>
                                            <div>
                                                <h4 className="font-semibold text-white">{org.name}</h4>
                                                <p className="text-xs text-slate-400">{org.description}</p>
                                                <div className="mt-1 text-[10px] text-slate-500 font-mono">
                                                    ID: {org.id}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button 
                                                onClick={() => handleDeleteOrg(org.id)}
                                                className="p-2 text-red-400 hover:bg-red-900/30 hover:text-red-300 rounded-lg transition-colors"
                                                title="Supprimer l'organisation"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
