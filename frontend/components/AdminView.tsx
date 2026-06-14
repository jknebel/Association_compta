import React, { useState, useEffect } from 'react';
import { useAuthContext, useOrgContext } from '../contexts/AppContext';
import { 
    createComptabilite, 
    listComptabilites, 
    deleteComptabilite,
    generateInviteLink,
    listInvitations,
    approveInvitation,
    rejectInvitation,
    getCustomFields,
    updateCustomFields
} from '../services/organizationService';
import { Comptabilite, Invitation, CustomField, OrgRole } from '../types/rbac';
import { Settings, Users, Book, Link as LinkIcon, Plus, Trash2, Check, X, Loader2, Copy } from 'lucide-react';

export const AdminView: React.FC = () => {
    const { user, isSuperAdmin } = useAuthContext();
    const { selectedOrg, orgRole } = useOrgContext();

    const [activeTab, setActiveTab] = useState<'comptas' | 'invitations' | 'settings'>('comptas');
    const [comptas, setComptas] = useState<Comptabilite[]>([]);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [loading, setLoading] = useState(false);

    // Form state pour nouvelle compta
    const [newComptaName, setNewComptaName] = useState('');
    const [newComptaDesc, setNewComptaDesc] = useState('');
    
    useEffect(() => {
        if (selectedOrg && (orgRole === OrgRole.ADMIN || isSuperAdmin)) {
            fetchData();
        }
    }, [selectedOrg, orgRole, isSuperAdmin]);

    const fetchData = async () => {
        if (!selectedOrg) return;
        setLoading(true);
        try {
            const [cList, iList] = await Promise.all([
                listComptabilites(selectedOrg.id),
                listInvitations(selectedOrg.id)
            ]);
            setComptas(cList);
            setInvitations(iList);
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

    const handleGenerateLink = async () => {
        if (!selectedOrg) return;
        try {
            const newCode = await generateInviteLink(selectedOrg.id);
            const link = `${window.location.origin}/?org=${selectedOrg.id}&code=${newCode}`;
            navigator.clipboard.writeText(link);
            alert("Lien d'invitation généré et copié dans le presse-papier !");
            // Le OrgContext n'est pas updaté automatiquement ici, mais on a copié le lien.
        } catch (e) {
            console.error(e);
        }
    };

    const handleApprove = async (inviteId: string) => {
        if (!selectedOrg || !user) return;
        try {
            await approveInvitation(selectedOrg.id, inviteId, user.uid);
            await fetchData();
        } catch (e) {
            console.error(e);
        }
    };

    const handleReject = async (inviteId: string) => {
        if (!selectedOrg || !user) return;
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
            </header>

            <div className="flex gap-4 border-b border-slate-800 mb-6">
                <button 
                    onClick={() => setActiveTab('comptas')}
                    className={`px-4 py-2 font-medium border-b-2 transition-colors ${activeTab === 'comptas' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    <Book size={16} className="inline mr-2" />
                    Comptabilités
                </button>
                <button 
                    onClick={() => setActiveTab('invitations')}
                    className={`px-4 py-2 font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'invitations' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                >
                    <Users size={16} />
                    Invitations 
                    {invitations.length > 0 && <span className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">{invitations.length}</span>}
                </button>
            </div>

            {loading ? (
                <div className="flex justify-center p-12 text-slate-500"><Loader2 className="animate-spin" size={32} /></div>
            ) : activeTab === 'comptas' ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="md:col-span-1 bg-slate-900 border border-slate-800 p-6 rounded-xl h-fit">
                        <h3 className="font-semibold text-white mb-4">Nouvelle Comptabilité</h3>
                        <form onSubmit={handleCreateCompta} className="space-y-4">
                            <input 
                                type="text" placeholder="Nom (ex: Saison 2026)" 
                                value={newComptaName} onChange={e => setNewComptaName(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white" required
                            />
                            <textarea 
                                placeholder="Description" 
                                value={newComptaDesc} onChange={e => setNewComptaDesc(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white"
                            />
                            <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-500 flex justify-center items-center gap-2">
                                <Plus size={16} /> Créer
                            </button>
                        </form>
                    </div>
                    <div className="md:col-span-2 space-y-4">
                        {comptas.map(c => (
                            <div key={c.id} className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex justify-between items-center">
                                <div>
                                    <h4 className="font-bold text-white text-lg">{c.name}</h4>
                                    <p className="text-slate-400 text-sm">{c.description}</p>
                                </div>
                                <button onClick={() => handleDeleteCompta(c.id)} className="text-red-400 hover:bg-red-900/30 p-2 rounded-lg">
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                <div className="space-y-6">
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl flex items-center justify-between">
                        <div>
                            <h3 className="font-semibold text-white text-lg">Lien d'invitation</h3>
                            <p className="text-slate-400 text-sm">Partagez ce lien pour inviter de nouveaux membres. Vous devrez valider leur demande.</p>
                        </div>
                        <button onClick={handleGenerateLink} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg flex items-center gap-2">
                            <LinkIcon size={16} />
                            Générer & Copier le lien
                        </button>
                    </div>

                    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                        <div className="p-4 border-b border-slate-800 bg-slate-950">
                            <h3 className="font-semibold text-white">Demandes en attente ({invitations.length})</h3>
                        </div>
                        {invitations.length === 0 ? (
                            <div className="p-8 text-center text-slate-500">Aucune demande en attente.</div>
                        ) : (
                            <div className="divide-y divide-slate-800">
                                {invitations.map(inv => (
                                    <div key={inv.id} className="p-4 flex items-center justify-between">
                                        <div>
                                            <h4 className="font-bold text-slate-200">{inv.firstName} {inv.lastName}</h4>
                                            <p className="text-slate-400 text-sm">{inv.email}</p>
                                            <div className="mt-2 flex gap-2 flex-wrap">
                                                {Object.entries(inv.customFields || {}).map(([k, v]) => (
                                                    <span key={k} className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded">
                                                        {k}: {v}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={() => handleApprove(inv.id)} className="bg-emerald-600/20 text-emerald-500 hover:bg-emerald-600/40 p-2 rounded-lg">
                                                <Check size={20} />
                                            </button>
                                            <button onClick={() => handleReject(inv.id)} className="bg-red-600/20 text-red-500 hover:bg-red-600/40 p-2 rounded-lg">
                                                <X size={20} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
