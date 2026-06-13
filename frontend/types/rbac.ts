// Enums for roles
export enum OrgRole {
    ADMIN = 'admin',
    MEMBER = 'member'
}

export enum ComptaRole {
    COMPTABLE = 'comptable',
    VIEWER = 'viewer'
}

// User Profile
export interface UserProfile {
    uid: string;
    email: string;
    firstName: string;
    lastName: string;
    displayName: string;
    createdAt: number;
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
    inviteCode: string;
    customFields: CustomField[];
}

export interface OrganizationMember {
    uid: string;
    role: OrgRole;
    displayName: string;
    email: string;
    firstName: string;
    lastName: string;
    customFields: Record<string, string>;
    status: 'pending' | 'approved' | 'rejected';
    joinedAt: number;
    approvedBy?: string;
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
