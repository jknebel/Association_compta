import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from 'firebase/auth';
import { useAuth as useFirebaseAuth, logout } from '../services/authService';
import { getUserProfile, createUserProfile, updateUserProfile, UNVERIFIED_EXPIRATION_MS, isExemptFromEmailVerification } from '../services/userService';
import { getDb } from '../services/organizationService';
import { doc, deleteDoc } from 'firebase/firestore';
import { UserProfile, Organization, Comptabilite, OrgRole, ComptaRole } from '../types/rbac';

// --- Auth Context ---
interface AuthContextType {
    user: User | null;
    userProfile: UserProfile | null;
    isSuperAdmin: boolean;
    loading: boolean;
    refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
    user: null,
    userProfile: null,
    isSuperAdmin: false,
    loading: true,
    refreshProfile: async () => {}
});

export const useAuthContext = () => useContext(AuthContext);

// --- Organization Context ---
interface OrgContextType {
    selectedOrg: Organization | null;
    orgRole: OrgRole | null;
    setSelectedOrg: (org: Organization | null) => void;
    setOrgRole: (role: OrgRole | null) => void;
}

const OrgContext = createContext<OrgContextType>({
    selectedOrg: null,
    orgRole: null,
    setSelectedOrg: () => {},
    setOrgRole: () => {}
});

export const useOrgContext = () => useContext(OrgContext);

// --- Comptabilite Context ---
interface ComptaContextType {
    selectedCompta: Comptabilite | null;
    comptaRole: ComptaRole | null;
    setSelectedCompta: (compta: Comptabilite | null) => void;
    setComptaRole: (role: ComptaRole | null) => void;
}

const ComptaContext = createContext<ComptaContextType>({
    selectedCompta: null,
    comptaRole: null,
    setSelectedCompta: () => {},
    setComptaRole: () => {}
});

export const useComptaContext = () => useContext(ComptaContext);

// --- Main Provider ---
export const AppProvider = ({ children }: { children: ReactNode }) => {
    const { user, loading: authLoading } = useFirebaseAuth();
    const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
    const [isSuperAdmin, setIsSuperAdmin] = useState(false);
    const [profileLoading, setProfileLoading] = useState(true);

    const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
    const [orgRole, setOrgRole] = useState<OrgRole | null>(null);

    const [selectedCompta, setSelectedCompta] = useState<Comptabilite | null>(null);
    const [comptaRole, setComptaRole] = useState<ComptaRole | null>(null);

    const refreshProfile = async () => {
        if (user) {
            try {
                try {
                    await user.reload();
                } catch (e) {
                    // ignore reload network errors
                }

                let profile = await getUserProfile(user.uid);
                if (!profile && user.email) {
                    const parts = (user.displayName || '').trim().split(' ');
                    await createUserProfile(user.uid, {
                        firstName: parts[0] || user.email.split('@')[0],
                        lastName: parts.slice(1).join(' ') || '',
                        email: user.email.trim().toLowerCase()
                    });
                    profile = await getUserProfile(user.uid);
                }

                if (profile && profile.emailVerificationRequired === true && profile.emailVerified === false) {
                    if (user.emailVerified || isExemptFromEmailVerification(user.email)) {
                        await updateUserProfile(user.uid, {
                            emailVerified: true,
                            emailVerificationRequired: false
                        });
                        profile = { ...profile, emailVerified: true, emailVerificationRequired: false };
                    } else if (profile.createdAt && Date.now() - profile.createdAt > UNVERIFIED_EXPIRATION_MS) {
                        // Compte non vérifié après 10 jours -> suppression automatique
                        try {
                            await deleteDoc(doc(getDb(), 'users', user.uid));
                        } catch (e) {
                            console.warn("Could not delete expired user profile:", e);
                        }
                        try {
                            await user.delete();
                        } catch (e) {
                            await logout();
                        }
                        alert("Ce compte a été supprimé car l'adresse e-mail n'a pas été vérifiée dans le délai de 10 jours.");
                        setUserProfile(null);
                        return;
                    }
                }

                setUserProfile(profile);
            } catch (e) {
                console.error("Failed to fetch/create user profile", e);
            }
            
            try {
                const idTokenResult = await user.getIdTokenResult();
                // Override for development/admin setup
                const isHardcodedAdmin = user.email === 'jean.francois.knebel@gmail.com' || user.email === 'jean-francois@knebel.ch';
                setIsSuperAdmin(!!idTokenResult.claims.superAdmin || isHardcodedAdmin);
            } catch (e) {
                console.error("Failed to get token claims", e);
            }
        } else {
            setUserProfile(null);
            setIsSuperAdmin(false);
        }
    };

    useEffect(() => {
        if (!authLoading) {
            refreshProfile().finally(() => setProfileLoading(false));
        }
    }, [user, authLoading]);

    return (
        <AuthContext.Provider value={{ user, userProfile, isSuperAdmin, loading: authLoading || profileLoading, refreshProfile }}>
            <OrgContext.Provider value={{ selectedOrg, orgRole, setSelectedOrg, setOrgRole }}>
                <ComptaContext.Provider value={{ selectedCompta, comptaRole, setSelectedCompta, setComptaRole }}>
                    {children}
                </ComptaContext.Provider>
            </OrgContext.Provider>
        </AuthContext.Provider>
    );
};
