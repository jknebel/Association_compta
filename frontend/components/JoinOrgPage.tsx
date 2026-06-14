import React, { useState, useEffect } from 'react';
import { getOrganizationByInviteCode, createInvitation } from '../services/organizationService';
import { Organization } from '../types/rbac';
import { useAuthContext } from '../contexts/AppContext';
import { Loader2, ArrowRight, ShieldCheck, AlertCircle } from 'lucide-react';
import { PendingApproval } from './PendingApproval';

interface JoinOrgPageProps {
    orgId: string;
    inviteCode: string;
    onSuccess?: () => void;
}

export const JoinOrgPage: React.FC<JoinOrgPageProps> = ({ orgId, inviteCode, onSuccess }) => {
    const { user, userProfile } = useAuthContext();
    const [organization, setOrganization] = useState<Organization | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    
    // Custom fields state
    const [customValues, setCustomValues] = useState<Record<string, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    useEffect(() => {
        const fetchOrg = async () => {
            try {
                const org = await getOrganizationByInviteCode(inviteCode);
                if (!org || org.id !== orgId) {
                    setError("Lien d'invitation invalide ou expiré.");
                } else {
                    setOrganization(org);
                    
                    // Initialize custom fields with empty strings
                    if (org.customFields) {
                        const initial: Record<string, string> = {};
                        org.customFields.forEach(f => initial[f.name] = '');
                        setCustomValues(initial);
                    }
                }
            } catch (err) {
                console.error("Erreur chargement org:", err);
                setError("Impossible de charger les détails de l'organisation.");
            } finally {
                setLoading(false);
            }
        };
        fetchOrg();
    }, [orgId, inviteCode]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user || !userProfile || !organization) return;
        
        setIsSubmitting(true);
        setError(null);
        try {
            await createInvitation(organization.id, {
                orgId: organization.id,
                uid: user.uid,
                email: user.email || '',
                firstName: userProfile.firstName,
                lastName: userProfile.lastName,
                customFields: customValues
            });
            setSubmitted(true);
            if (onSuccess) onSuccess();
        } catch (err: any) {
            console.error("Submit error:", err);
            setError(err.message || "Erreur lors de l'envoi de la demande.");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-4">
                <Loader2 className="animate-spin text-blue-500" size={32} />
                <span>Validation du lien d'invitation...</span>
            </div>
        );
    }

    if (error || !organization) {
        return (
            <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
                <div className="bg-red-900/20 border border-red-900/50 p-6 rounded-xl max-w-md w-full text-center">
                    <AlertCircle className="text-red-500 mx-auto mb-4" size={48} />
                    <h2 className="text-xl font-bold text-white mb-2">Lien invalide</h2>
                    <p className="text-slate-400 mb-6">{error}</p>
                    <button 
                        onClick={() => window.location.href = '/'}
                        className="bg-slate-800 text-white px-6 py-2 rounded-lg hover:bg-slate-700 transition-colors"
                    >
                        Retour à l'accueil
                    </button>
                </div>
            </div>
        );
    }

    if (submitted) {
        return <PendingApproval orgName={organization.name} />;
    }

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
            <div className="w-full max-w-md bg-slate-900 rounded-2xl shadow-xl border border-slate-800 overflow-hidden">
                <div className="p-8">
                    <div className="flex justify-center mb-6">
                        <div className="bg-emerald-900/30 p-4 rounded-full border border-emerald-800/50">
                            <ShieldCheck size={32} className="text-emerald-500" />
                        </div>
                    </div>
                    
                    <h2 className="text-2xl font-bold text-white text-center mb-2">Rejoindre {organization.name}</h2>
                    <p className="text-slate-400 text-center text-sm mb-8">
                        Veuillez remplir les informations requises par l'administrateur pour finaliser votre inscription.
                    </p>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        {/* Champs fixes */}
                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Prénom</label>
                                <input
                                    type="text"
                                    value={userProfile?.firstName || ''}
                                    disabled
                                    className="w-full bg-slate-800/50 border border-slate-700 rounded-lg py-2.5 px-4 text-slate-400 cursor-not-allowed"
                                />
                            </div>
                            <div className="flex-1">
                                <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Nom</label>
                                <input
                                    type="text"
                                    value={userProfile?.lastName || ''}
                                    disabled
                                    className="w-full bg-slate-800/50 border border-slate-700 rounded-lg py-2.5 px-4 text-slate-400 cursor-not-allowed"
                                />
                            </div>
                        </div>

                        {/* Champs dynamiques */}
                        {organization.customFields?.map(field => (
                            <div key={field.name}>
                                <label className="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">
                                    {field.label} {field.required && <span className="text-red-500">*</span>}
                                </label>
                                
                                {field.type === 'select' ? (
                                    <select
                                        value={customValues[field.name] || ''}
                                        onChange={(e) => setCustomValues({...customValues, [field.name]: e.target.value})}
                                        required={field.required}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2.5 px-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                    >
                                        <option value="">Sélectionner...</option>
                                        {field.options?.map(opt => (
                                            <option key={opt} value={opt}>{opt}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                                        value={customValues[field.name] || ''}
                                        onChange={(e) => setCustomValues({...customValues, [field.name]: e.target.value})}
                                        required={field.required}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg py-2.5 px-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                    />
                                )}
                            </div>
                        ))}

                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 mt-6 shadow-lg shadow-blue-900/20"
                        >
                            {isSubmitting ? (
                                <span className="animate-pulse">Envoi en cours...</span>
                            ) : (
                                <>
                                    Soumettre la demande
                                    <ArrowRight size={18} />
                                </>
                            )}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};
