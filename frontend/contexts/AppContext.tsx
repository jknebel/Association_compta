import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User } from 'firebase/auth';
import { useAuth as useFirebaseAuth } from '../services/authService';
import { getUserProfile } from '../services/userService';
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
            const profile = await getUserProfile(user.uid);
            setUserProfile(profile);
            
            try {
                const idTokenResult = await user.getIdTokenResult();
                setIsSuperAdmin(!!idTokenResult.claims.superAdmin);
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
