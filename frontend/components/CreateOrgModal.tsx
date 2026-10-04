import React, { useState, useEffect } from 'react';
import { useAuthContext } from '../contexts/AppContext';
import { createOrganization } from '../services/organizationService';
import { listAllRegisteredUsers } from '../services/userService';
import { Building2, X, Check, Loader2, User } from 'lucide-react';

interface CreateOrgModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (newOrgId: string) => void;
}

export const CreateOrgModal: React.FC<CreateOrgModalProps> = ({ isOpen, onClose, onSuccess }) => {
    const { user } = useAuthContext();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [adminEmail, setAdminEmail] = useState('');
    const [registeredUsers, setRegisteredUsers] = useState<Array<{ uid: string; email: string; displayName: string }>>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (isOpen && user?.email) {
            setAdminEmail(user.email);
            setName('');
            setDescription('');
            // Load registered users so admin can pick another administrator if desired
            listAllRegisteredUsers().then(users => {
                setRegisteredUsers(users);
            }).catch(console.error);
        }
    }, [isOpen, user]);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user || !name.trim()) return;

        setIsSubmitting(true);
        try {
            const finalAdminEmail = adminEmail.trim() || user.email || '';
            const newOrgId = await createOrganization(
                name.trim(),
                description.trim(),
                user.uid,
                finalAdminEmail
            );
            onSuccess(newOrgId);
            onClose();
        } catch (error: any) {
            console.error("Error creating organization:", error);
            alert("Erreur lors de la création de l'organisation : " + (error.message || "Erreur inconnue"));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-2xl animate-in fade-in zoom-in-95">
                <div className="flex justify-between items-center mb-5 pb-3 border-b border-slate-800">
                    <div className="flex items-center gap-2.5">
                        <div className="p-2 bg-blue-600/20 text-blue-400 rounded-lg border border-blue-500/20">
                            <Building2 size={20} />
                        </div>
                        <div>
                            <h3 className="font-bold text-white text-lg">Créer une nouvelle organisation</h3>
                            <p className="text-xs text-slate-400">Ajoutez une association ou un groupe et devenez-en l'administrateur</p>
                        </div>
                    </div>
                    <button 
                        onClick={onClose} 
                        className="text-slate-500 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                            Nom de l'organisation *
                        </label>
                        <input
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="ex: TDGL, Club Sportif, Association ABC"
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                            Description (optionnel)
                        </label>
                        <textarea
                            rows={2}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Objet ou informations sur l'association..."
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-colors resize-none"
                        />
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                                Administrateur de l'organisation
                            </label>
                            {registeredUsers.length > 0 && (
                                <span className="text-[11px] text-blue-400">
                                    {registeredUsers.length} inscrits disponibles
                                </span>
                            )}
                        </div>

                        {registeredUsers.length > 0 && (
                            <select
                                value={registeredUsers.some(u => u.email === adminEmail.trim().toLowerCase()) ? adminEmail.trim().toLowerCase() : ''}
                                onChange={(e) => {
                                    if (e.target.value) setAdminEmail(e.target.value);
                                }}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 mb-2 focus:outline-none focus:border-blue-500"
                            >
                                <option value="">-- Choisir parmi les utilisateurs inscrits --</option>
                                {registeredUsers.map(u => (
                                    <option key={u.uid} value={u.email}>
                                        {u.displayName} ({u.email}) {u.email === user?.email?.toLowerCase() ? '(Vous)' : ''}
                                    </option>
                                ))}
                            </select>
                        )}

                        <div className="relative">
                            <User size={14} className="absolute left-3 top-3 text-slate-500" />
                            <input
                                type="email"
                                required
                                value={adminEmail}
                                onChange={(e) => setAdminEmail(e.target.value)}
                                placeholder="email@exemple.ch"
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3.5 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
                            />
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">
                            Par défaut votre adresse. Vous pouvez également désigner un autre compte administrateur.
                        </p>
                    </div>

                    <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={isSubmitting}
                            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors"
                        >
                            Annuler
                        </button>
                        <button
                            type="submit"
                            disabled={isSubmitting || !name.trim()}
                            className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm font-semibold shadow-lg shadow-blue-600/20 transition-all cursor-pointer"
                        >
                            {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                            Créer l'organisation
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
