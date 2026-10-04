import { doc, setDoc, getDoc, updateDoc, collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { getDb } from './organizationService';
import { UserProfile, Comptabilite, ComptaRole } from '../types/rbac';

export const createUserProfile = async (uid: string, data: { firstName: string, lastName: string, email: string }): Promise<void> => {
    const db = getDb();
    const userRef = doc(db, 'users', uid);
    const docSnap = await getDoc(userRef);
    
    if (!docSnap.exists()) {
        const newUser: UserProfile = {
            uid,
            ...data,
            displayName: `${data.firstName} ${data.lastName}`,
            createdAt: Date.now(),
            organizations: {}
        };
        await setDoc(userRef, newUser);
    }
}

export const getUserProfile = async (uid: string): Promise<UserProfile | null> => {
    const db = getDb();
    const docSnap = await getDoc(doc(db, 'users', uid));
    if (docSnap.exists()) {
        return docSnap.data() as UserProfile;
    }
    return null;
}

export const updateUserProfile = async (uid: string, data: Partial<UserProfile>): Promise<void> => {
    const db = getDb();
    await updateDoc(doc(db, 'users', uid), data);
}

export const getUserComptabilites = async (uid: string, userEmail?: string): Promise<Array<{ orgId: string, compta: Comptabilite, role: ComptaRole }>> => {
    const db = getDb();
    const result: Array<{ orgId: string, compta: Comptabilite, role: ComptaRole }> = [];
    const seenComptaIds = new Set<string>();
    const normalizedEmail = userEmail?.trim().toLowerCase();

    try {
        // 1. Direct compta members by uid: organizations/{orgId}/comptabilites/{comptaId}/members/{uid}
        const membersQuery = query(collectionGroup(db, 'members'), where('uid', '==', uid));
        const membersSnapshot = await getDocs(membersQuery);
        
        for (const memberDoc of membersSnapshot.docs) {
            const pathSegments = memberDoc.ref.path.split('/');
            // Check direct compta member
            if (pathSegments.length === 6 && pathSegments[0] === 'organizations' && pathSegments[2] === 'comptabilites' && pathSegments[4] === 'members') {
                const orgId = pathSegments[1];
                const comptaId = pathSegments[3];
                const role = memberDoc.data().role as ComptaRole;
                
                if (!seenComptaIds.has(comptaId)) {
                    const comptaSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId));
                    if (comptaSnap.exists()) {
                        seenComptaIds.add(comptaId);
                        result.push({
                            orgId,
                            compta: comptaSnap.data() as Comptabilite,
                            role
                        });
                    }
                }
            }
            
            // Check org member with comptaAccess map
            if (pathSegments.length === 4 && pathSegments[0] === 'organizations' && pathSegments[2] === 'members') {
                const orgId = pathSegments[1];
                const comptaAccess = memberDoc.data().comptaAccess as Record<string, ComptaRole> | undefined;
                if (comptaAccess) {
                    for (const [comptaId, role] of Object.entries(comptaAccess)) {
                        if (!seenComptaIds.has(comptaId)) {
                            const comptaSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId));
                            if (comptaSnap.exists()) {
                                seenComptaIds.add(comptaId);
                                result.push({
                                    orgId,
                                    compta: comptaSnap.data() as Comptabilite,
                                    role
                                });
                            }
                        }
                    }
                }
            }
        }

        // 2. Org members by email if invited before user had uid
        if (normalizedEmail) {
            const emailMembersQuery = query(collectionGroup(db, 'members'), where('email', '==', normalizedEmail));
            const emailSnap = await getDocs(emailMembersQuery);
            for (const memberDoc of emailSnap.docs) {
                const pathSegments = memberDoc.ref.path.split('/');
                if (pathSegments.length === 4 && pathSegments[0] === 'organizations' && pathSegments[2] === 'members') {
                    const orgId = pathSegments[1];
                    const comptaAccess = memberDoc.data().comptaAccess as Record<string, ComptaRole> | undefined;
                    if (comptaAccess) {
                        for (const [comptaId, role] of Object.entries(comptaAccess)) {
                            if (!seenComptaIds.has(comptaId)) {
                                const comptaSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId));
                                if (comptaSnap.exists()) {
                                    seenComptaIds.add(comptaId);
                                    result.push({
                                        orgId,
                                        compta: comptaSnap.data() as Comptabilite,
                                        role
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error fetching user comptabilites: ", error);
    }
    
    return result;
};

export const listAllRegisteredUsers = async (): Promise<Array<{ uid: string; email: string; displayName: string; firstName?: string; lastName?: string }>> => {
    try {
        const db = getDb();
        const snap = await getDocs(collection(db, 'users'));
        return snap.docs
            .map(d => {
                const data = d.data();
                const displayName = data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email || 'Utilisateur';
                return {
                    uid: d.id,
                    email: (data.email || '').trim().toLowerCase(),
                    displayName,
                    firstName: data.firstName || '',
                    lastName: data.lastName || ''
                };
            })
            .filter(u => !!u.email);
    } catch (e) {
        console.error("Error listing registered users:", e);
        return [];
    }
};
