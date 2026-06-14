import { collection, doc, setDoc, getDoc, updateDoc, deleteDoc, getDocs, query, where } from 'firebase/firestore';
import { getFirestore } from 'firebase/firestore';
import { app } from './dataService';
import { Organization, Comptabilite, CustomField, Invitation, OrgRole, ComptaRole } from '../types/rbac';

export const getDb = () => {
    if (!app) throw new Error("Firebase app not initialized");
    return getFirestore(app);
}

export const createOrganization = async (name: string, description: string, adminUid: string): Promise<string> => {
    const db = getDb();
    const orgRef = doc(collection(db, 'organizations'));
    const orgId = orgRef.id;

    const newOrg: Organization = {
        id: orgId,
        name,
        description,
        createdAt: Date.now(),
        createdBy: adminUid,
        inviteCode: Math.random().toString(36).substring(2, 10),
        customFields: []
    };

    await setDoc(orgRef, newOrg);
    
    // Add admin to members
    const memberRef = doc(db, 'organizations', orgId, 'members', adminUid);
    await setDoc(memberRef, {
        role: OrgRole.ADMIN,
        status: 'approved',
        joinedAt: Date.now(),
        uid: adminUid
    });

    return orgId;
};

export const deleteOrganization = async (orgId: string): Promise<void> => {
    const db = getDb();
    await deleteDoc(doc(db, 'organizations', orgId));
};

export const getOrganization = async (orgId: string): Promise<Organization | null> => {
    const db = getDb();
    const docSnap = await getDoc(doc(db, 'organizations', orgId));
    if (docSnap.exists()) {
        return docSnap.data() as Organization;
    }
    return null;
}

export const updateOrganization = async (orgId: string, data: Partial<Organization>): Promise<void> => {
    const db = getDb();
    await updateDoc(doc(db, 'organizations', orgId), data);
}

export const createComptabilite = async (orgId: string, data: Omit<Comptabilite, 'id' | 'createdAt'>): Promise<string> => {
    const db = getDb();
    const comptaRef = doc(collection(db, 'organizations', orgId, 'comptabilites'));
    
    const newCompta: Comptabilite = {
        ...data,
        id: comptaRef.id,
        createdAt: Date.now()
    };

    await setDoc(comptaRef, newCompta);
    return comptaRef.id;
}

export const deleteComptabilite = async (orgId: string, comptaId: string): Promise<void> => {
    const db = getDb();
    await deleteDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId));
}

export const listComptabilites = async (orgId: string): Promise<Comptabilite[]> => {
    const db = getDb();
    const snapshot = await getDocs(collection(db, 'organizations', orgId, 'comptabilites'));
    return snapshot.docs.map(doc => doc.data() as Comptabilite);
}

export const generateInviteLink = async (orgId: string): Promise<string> => {
    const db = getDb();
    const newCode = Math.random().toString(36).substring(2, 10);
    await updateDoc(doc(db, 'organizations', orgId), { inviteCode: newCode });
    return newCode;
}

export const getCustomFields = async (orgId: string): Promise<CustomField[]> => {
    const org = await getOrganization(orgId);
    return org?.customFields || [];
}

export const updateCustomFields = async (orgId: string, fields: CustomField[]): Promise<void> => {
    const db = getDb();
    await updateDoc(doc(db, 'organizations', orgId), { customFields: fields });
}

export const listInvitations = async (orgId: string): Promise<Invitation[]> => {
    const db = getDb();
    const snapshot = await getDocs(query(collection(db, 'organizations', orgId, 'invitations'), where('status', '==', 'pending')));
    return snapshot.docs.map(doc => doc.data() as Invitation);
}

export const approveInvitation = async (orgId: string, inviteId: string, uid: string): Promise<void> => {
    const db = getDb();
    
    // Update invitation status
    const inviteRef = doc(db, 'organizations', orgId, 'invitations', inviteId);
    await updateDoc(inviteRef, { status: 'approved', reviewedBy: uid });
    
    // Add user to org members
    const inviteSnap = await getDoc(inviteRef);
    if (inviteSnap.exists()) {
        const inviteData = inviteSnap.data() as Invitation;
        const memberRef = doc(db, 'organizations', orgId, 'members', inviteData.uid);
        await setDoc(memberRef, {
            uid: inviteData.uid,
            role: OrgRole.MEMBER,
            email: inviteData.email,
            firstName: inviteData.firstName,
            lastName: inviteData.lastName,
            customFields: inviteData.customFields,
            status: 'approved',
            joinedAt: Date.now(),
            approvedBy: uid
        });
    }
}

export const rejectInvitation = async (orgId: string, inviteId: string, uid: string): Promise<void> => {
    const db = getDb();
    await updateDoc(doc(db, 'organizations', orgId, 'invitations', inviteId), { status: 'rejected', reviewedBy: uid });
}

export const addMemberToCompta = async (orgId: string, comptaId: string, uid: string, role: ComptaRole): Promise<void> => {
    const db = getDb();
    await setDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'members', uid), {
        uid,
        role,
        addedAt: Date.now()
    });
}

export const removeMemberFromCompta = async (orgId: string, comptaId: string, uid: string): Promise<void> => {
    const db = getDb();
    await deleteDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'members', uid));
}

export const updateMemberRole = async (orgId: string, comptaId: string, uid: string, newRole: ComptaRole): Promise<void> => {
    const db = getDb();
    await updateDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'members', uid), { role: newRole });
}

export const getOrganizationByInviteCode = async (inviteCode: string): Promise<Organization | null> => {
    const db = getDb();
    const q = query(collection(db, 'organizations'), where('inviteCode', '==', inviteCode));
    const snapshot = await getDocs(q);
    if (!snapshot.empty) {
        return snapshot.docs[0].data() as Organization;
    }
    return null;
}

export const createInvitation = async (orgId: string, inviteData: Omit<Invitation, 'id' | 'requestedAt' | 'status'>): Promise<string> => {
    const db = getDb();
    const inviteRef = doc(collection(db, 'organizations', orgId, 'invitations'));
    
    const newInvite: Invitation = {
        ...inviteData,
        id: inviteRef.id,
        status: 'pending',
        requestedAt: Date.now()
    };

    await setDoc(inviteRef, newInvite);
    return inviteRef.id;
}
