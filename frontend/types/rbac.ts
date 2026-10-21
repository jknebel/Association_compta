// Enums for roles
export enum OrgRole {
    ADMIN = 'admin',
    CAISSIER = 'caissier',
    MEMBER = 'member'
}

export enum ComptaRole {
    CAISSIER = 'caissier',
    VERIFICATEUR = 'verificateur',
    VIEWER = 'viewer',
    UPLOADER = 'uploader', // Déposant de factures (App Mobile uniquement)
    COMPTABLE = 'comptable' // Rétro-compatibilité
}

export const normalizeRoleInput = (role?: ComptaRole | OrgRole | string | null): string => {
    if (typeof role !== 'string') return '';
    return role.trim().toLowerCase();
};

export const isCaissierRole = (role?: ComptaRole | string | null): boolean => {
    const norm = normalizeRoleInput(role);
    return norm === ComptaRole.CAISSIER || norm === ComptaRole.COMPTABLE || norm === 'admin';
};

export const isVerificateurRole = (role?: ComptaRole | string | null): boolean => {
    const norm = normalizeRoleInput(role);
    return norm === ComptaRole.VERIFICATEUR;
};

export const isViewerRole = (role?: ComptaRole | string | null): boolean => {
    const norm = normalizeRoleInput(role);
    return norm === ComptaRole.VIEWER;
};

export const isUploaderRole = (role?: ComptaRole | string | null): boolean => {
    const norm = normalizeRoleInput(role);
    return norm === ComptaRole.UPLOADER;
};

export const isValidComptaRole = (role?: string | null): role is ComptaRole => {
    const norm = normalizeRoleInput(role);
    return (
        norm === ComptaRole.CAISSIER ||
        norm === ComptaRole.COMPTABLE ||
        norm === ComptaRole.VERIFICATEUR ||
        norm === ComptaRole.VIEWER ||
        norm === ComptaRole.UPLOADER
    );
};

export const canOpenComptaOnWeb = (
    role?: ComptaRole | string | null,
    isOrgAdmin = false,
    isSuperAdmin = false
): boolean => {
    if (isSuperAdmin === true || isOrgAdmin === true) return true;
    const norm = normalizeRoleInput(role);
    if (norm === 'admin') return true;
    return isCaissierRole(norm) || isVerificateurRole(norm) || isViewerRole(norm);
};

export const canUploadReceiptToCompta = (
    role?: ComptaRole | string | null,
    isArchived = false,
    isOrgAdmin = false,
    isSuperAdmin = false
): boolean => {
    if (isArchived === true) return false;
    if (isSuperAdmin === true || isOrgAdmin === true) return true;
    const norm = normalizeRoleInput(role);
    return isUploaderRole(norm) || isCaissierRole(norm);
};

export const getComptaRoleLabel = (role?: ComptaRole | string | null): string => {
    const norm = normalizeRoleInput(role);
    if (norm === 'admin') return 'Admin';
    if (isCaissierRole(norm)) return 'Caissier';
    if (isVerificateurRole(norm)) return 'Vérificateur';
    if (isViewerRole(norm)) return 'Lecteur';
    if (isUploaderRole(norm)) return 'Déposant Factures';
    return 'Aucun accès';
};

export const applyComptaRoleChange = (
    currentAccess: Record<string, ComptaRole> | undefined | null,
    comptaId: string,
    newRole: ComptaRole | 'none' | string | null | undefined
): Record<string, ComptaRole> => {
    const cleanComptaId = typeof comptaId === 'string' ? comptaId.trim() : '';
    if (!cleanComptaId) {
        throw new Error('Identifiant de comptabilité invalide');
    }

    const nextAccess: Record<string, ComptaRole> = { ...(currentAccess || {}) };
    const normRole = normalizeRoleInput(newRole);

    if (!normRole || normRole === 'none') {
        delete nextAccess[cleanComptaId];
        return nextAccess;
    }

    if (!isValidComptaRole(normRole)) {
        throw new Error(`Rôle de comptabilité invalide: ${String(newRole)}`);
    }

    nextAccess[cleanComptaId] = normRole as ComptaRole;
    return nextAccess;
};

// User Profile
export interface UserProfile {
    uid: string;
    email: string;
    firstName: string;
    lastName: string;
    displayName: string;
    createdAt: number;
    orgId?: string;
    orgName?: string;
    emailVerified?: boolean;
    emailVerificationRequired?: boolean;
    organizations: Record<string, {
        role: OrgRole;
        status: 'pending' | 'approved' | 'rejected';
    }>;
}

// Custom Fields
export interface CustomField {
    name: string;
    label: string;
    type: 'text' | 'select' | 'number' | 'date';
    required: boolean;
    options?: string[]; // for 'select' type
}

// Organization
export interface Organization {
    id: string;
    name: string;
    description: string;
    createdAt: number;
    createdBy: string;
    adminEmail?: string;
    adminUid?: string;
    inviteCode: string;
    customFields: CustomField[];
}

export interface OrganizationMember {
    uid?: string;
    id?: string;
    role: OrgRole;
    displayName?: string;
    email: string;
    firstName?: string;
    lastName?: string;
    customFields?: Record<string, string>;
    status: 'pending' | 'approved' | 'rejected';
    joinedAt: number;
    approvedBy?: string;
    comptaAccess?: Record<string, ComptaRole>; // map comptaId -> 'comptable' | 'viewer'
}

export interface TransactionComment {
    id: string;
    authorEmail: string;
    authorName: string;
    authorRole: string;
    text: string;
    createdAt: number;
}

// Comptabilite
export interface Comptabilite {
    id: string;
    name: string;
    description: string;
    createdAt: number;
    createdBy: string;
    fiscalYearStart: string; // YYYY-MM-DD
    fiscalYearEnd: string;   // YYYY-MM-DD
    currency: string;
    isArchived?: boolean;
    archivedAt?: number;
}

export interface ComptaMember {
    uid: string;
    role: ComptaRole;
    addedAt: number;
}

// Invitation
export interface Invitation {
    id: string;
    orgId: string;
    email: string;
    firstName: string;
    lastName: string;
    customFields: Record<string, string>;
    uid: string; // Firebase Auth UID
    status: 'pending' | 'approved' | 'rejected';
    requestedAt: number;
    reviewedBy?: string;
}
