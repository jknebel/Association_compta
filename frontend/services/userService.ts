import { doc, setDoc, getDoc, updateDoc, collectionGroup, getDocs, query, where } from 'firebase/firestore';
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

export const getUserComptabilites = async (uid: string): Promise<Array<{ orgId: string, compta: Comptabilite, role: ComptaRole }>> => {
    const db = getDb();
    const result: Array<{ orgId: string, compta: Comptabilite, role: ComptaRole }> = [];
    
    try {
        const membersQuery = query(collectionGroup(db, 'members'), where('uid', '==', uid));
        const membersSnapshot = await getDocs(membersQuery);
        
        for (const memberDoc of membersSnapshot.docs) {
            // Path: organizations/{orgId}/comptabilites/{comptaId}/members/{uid}
            const pathSegments = memberDoc.ref.path.split('/');
            if (pathSegments.length === 6 && pathSegments[0] === 'organizations' && pathSegments[2] === 'comptabilites' && pathSegments[4] === 'members') {
                const orgId = pathSegments[1];
                const comptaId = pathSegments[3];
                const role = memberDoc.data().role as ComptaRole;
                
                const comptaSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId));
                if (comptaSnap.exists()) {
                    result.push({
                        orgId,
                        compta: comptaSnap.data() as Comptabilite,
                        role
                    });
                }
            }
        }
    } catch (error) {
        console.error("Error fetching user comptabilites: ", error);
    }
    
    return result;
}
