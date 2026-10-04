// Enums for roles
export enum OrgRole {
    ADMIN = 'admin',
    MEMBER = 'member'
}

export enum ComptaRole {
    CAISSIER = 'caissier',
    VERIFICATEUR = 'verificateur',
    VIEWER = 'viewer',
    COMPTABLE = 'comptable' // Rétro-compatibilité
}

export const isCaissierRole = (role?: ComptaRole | string | null): boolean => 
    role === ComptaRole.CAISSIER || role === ComptaRole.COMPTABLE || role === 'caissier' || role === 'comptable' || role === 'admin';

export const isVerificateurRole = (role?: ComptaRole | string | null): boolean => 
    role === ComptaRole.VERIFICATEUR || role === 'verificateur';

export const isViewerRole = (role?: ComptaRole | string | null): boolean => 
    role === ComptaRole.VIEWER || role === 'viewer';

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
