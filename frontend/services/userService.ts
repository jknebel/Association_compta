import { doc, setDoc, getDoc, updateDoc, collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { getDb } from './organizationService';
import { UserProfile, Comptabilite, ComptaRole, OrgRole } from '../types/rbac';

export const createUserProfile = async (
    uid: string, 
    data: { firstName: string; lastName: string; email: string; orgId?: string; orgName?: string }
): Promise<void> => {
    const db = getDb();
    const userRef = doc(db, 'users', uid);
    const docSnap = await getDoc(userRef);
    
    const assignedOrgId = data.orgId || 'TDGL';
    const assignedOrgName = data.orgName || 'TDGL';
    const normalizedEmail = (data.email || '').trim().toLowerCase();

    if (!docSnap.exists()) {
        const newUser: UserProfile = {
            uid,
            ...data,
            email: normalizedEmail,
            displayName: `${data.firstName} ${data.lastName}`.trim() || normalizedEmail.split('@')[0],
            createdAt: Date.now(),
            orgId: assignedOrgId,
            orgName: assignedOrgName,
            organizations: {
                [assignedOrgId]: {
                    role: OrgRole.MEMBER,
                    status: 'pending'
                }
            }
        };
        await setDoc(userRef, newUser);
    } else {
        const existingData = docSnap.data();
        const updates: Record<string, any> = {};
        if (data.orgId && !existingData?.orgId) {
            updates.orgId = assignedOrgId;
            updates.orgName = assignedOrgName;
        }
        if (normalizedEmail && existingData?.email !== normalizedEmail) {
            updates.email = normalizedEmail;
        }
        if (Object.keys(updates).length > 0) {
            await updateDoc(userRef, updates);
        }
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
        // 1. Parcourir directement les organisations et leurs membres (ne dépend d'aucun index collectionGroup)
        const orgsSnap = await getDocs(collection(db, 'organizations'));
        for (const orgDoc of orgsSnap.docs) {
            const orgId = orgDoc.id;
            const membersSnap = await getDocs(collection(db, 'organizations', orgId, 'members'));

            for (const memberDoc of membersSnap.docs) {
                const mData = memberDoc.data();
                const matchesUid = memberDoc.id === uid || mData.uid === uid;
                const matchesEmail = normalizedEmail && (
                    memberDoc.id.toLowerCase() === normalizedEmail ||
                    (mData.email && mData.email.trim().toLowerCase() === normalizedEmail)
                );

                if ((matchesUid || matchesEmail) && mData.status !== 'rejected') {
                    const comptaAccess = mData.comptaAccess as Record<string, ComptaRole> | undefined;
                    if (comptaAccess) {
                        for (const [comptaId, role] of Object.entries(comptaAccess)) {
                            if (role && (role as string) !== 'none' && !seenComptaIds.has(comptaId)) {
                                const comptaSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId));
                                if (comptaSnap.exists()) {
                                    seenComptaIds.add(comptaId);
                                    result.push({
                                        orgId,
                                        compta: { ...(comptaSnap.data() as Comptabilite), id: comptaSnap.id },
                                        role
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // Vérifier aussi les sous-collections directes comptabilites/{comptaId}/members/{uid}
            const comptasSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites'));
            for (const cDoc of comptasSnap.docs) {
                const comptaId = cDoc.id;
                if (seenComptaIds.has(comptaId)) continue;
                const directMemberSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'members', uid));
                if (directMemberSnap.exists()) {
                    const role = directMemberSnap.data().role as ComptaRole;
                    if (role && (role as string) !== 'none') {
                        seenComptaIds.add(comptaId);
                        result.push({
                            orgId,
                            compta: { ...(cDoc.data() as Comptabilite), id: cDoc.id },
                            role
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error fetching user comptabilites: ", error);
    }
    
    return result;
};

export const listAllRegisteredUsers = async (
    filterOrgId?: string,
    filterOrgName?: string
): Promise<Array<{ uid: string; email: string; displayName: string; firstName?: string; lastName?: string; orgId?: string; orgName?: string }>> => {
    try {
        const db = getDb();
        const snap = await getDocs(collection(db, 'users'));
        return snap.docs
            .map(d => {
                const data = d.data();
                const displayName = data.displayName || `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email || 'Utilisateur';
                const userOrgId = data.orgId || (data.organizations ? Object.keys(data.organizations)[0] : '');
                const userOrgName = data.orgName || '';
                return {
                    uid: d.id,
                    email: (data.email || '').trim().toLowerCase(),
                    displayName,
                    firstName: data.firstName || '',
                    lastName: data.lastName || '',
                    orgId: userOrgId,
                    orgName: userOrgName
                };
            })
            .filter(u => !!u.email)
            .filter(u => {
                if (!filterOrgId) return true; // SuperAdmin voit tout le monde
                if (u.orgId === filterOrgId) return true;
                if (filterOrgName && (
                    u.orgName?.toUpperCase() === filterOrgName.toUpperCase() ||
                    u.orgId?.toUpperCase() === filterOrgName.toUpperCase()
                )) {
                    return true;
                }
                const isTDGL = filterOrgId.toUpperCase().includes('TDGL') || (filterOrgName || '').toUpperCase().includes('TDGL');
                if (isTDGL && (!u.orgId || u.orgId.toUpperCase().includes('TDGL') || u.orgName?.toUpperCase().includes('TDGL'))) {
                    return true;
                }
                return false;
            });
    } catch (e) {
        console.error("Error listing registered users:", e);
        return [];
    }
};
