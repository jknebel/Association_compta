import { collection, collectionGroup, doc, setDoc, getDoc, updateDoc, deleteDoc, getDocs, query, where } from 'firebase/firestore';
import { getFirestore } from 'firebase/firestore';
import { app } from './dataService';
import { Organization, Comptabilite, CustomField, Invitation, OrgRole, ComptaRole, OrganizationMember } from '../types/rbac';

export const getDb = () => {
    if (!app) throw new Error("Firebase app not initialized");
    return getFirestore(app);
}

export const createOrganization = async (
    name: string, 
    description: string, 
    adminUid: string, 
    adminEmail?: string
): Promise<string> => {
    const db = getDb();
    const orgRef = doc(collection(db, 'organizations'));
    const orgId = orgRef.id;

    const normalizedAdminEmail = adminEmail ? adminEmail.trim().toLowerCase() : undefined;

    const newOrg: Organization = {
        id: orgId,
        name,
        description,
        createdAt: Date.now(),
        createdBy: adminUid,
        adminEmail: normalizedAdminEmail,
        inviteCode: Math.random().toString(36).substring(2, 10),
        customFields: []
    };

    await setDoc(orgRef, newOrg);
    
    // Add Super Admin creator to members
    const creatorMemberRef = doc(db, 'organizations', orgId, 'members', adminUid);
    await setDoc(creatorMemberRef, {
        role: OrgRole.ADMIN,
        status: 'approved',
        joinedAt: Date.now(),
        uid: adminUid
    });

    // If an admin email was specified and differs from creator, also link them as ADMIN
    if (normalizedAdminEmail) {
        const usersSnap = await getDocs(query(collection(db, 'users'), where('email', '==', normalizedAdminEmail)));
        const targetDocId = !usersSnap.empty ? usersSnap.docs[0].id : normalizedAdminEmail;
        const targetUid = !usersSnap.empty ? usersSnap.docs[0].id : undefined;

        const orgAdminMemberRef = doc(db, 'organizations', orgId, 'members', targetDocId);
        await setDoc(orgAdminMemberRef, {
            role: OrgRole.ADMIN,
            status: 'approved',
            joinedAt: Date.now(),
            email: normalizedAdminEmail,
            uid: targetUid || null
        }, { merge: true });
    }

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

export const changeOrganizationAdmin = async (orgId: string, newAdminEmail: string): Promise<void> => {
    const db = getDb();
    const normalized = newAdminEmail.trim().toLowerCase();

    // 1. Update org document
    await updateDoc(doc(db, 'organizations', orgId), {
        adminEmail: normalized
    });

    // 2. Link member as ADMIN in organization members
    const usersSnap = await getDocs(query(collection(db, 'users'), where('email', '==', normalized)));
    const targetDocId = !usersSnap.empty ? usersSnap.docs[0].id : normalized;
    const targetUid = !usersSnap.empty ? usersSnap.docs[0].id : undefined;

    const orgAdminMemberRef = doc(db, 'organizations', orgId, 'members', targetDocId);
    await setDoc(orgAdminMemberRef, {
        role: OrgRole.ADMIN,
        status: 'approved',
        joinedAt: Date.now(),
        email: normalized,
        uid: targetUid || null
    }, { merge: true });
};

export const createComptabilite = async (orgId: string, data: Omit<Comptabilite, 'id' | 'createdAt'>, creatorUid: string): Promise<string> => {
    const db = getDb();
    const comptaRef = doc(collection(db, 'organizations', orgId, 'comptabilites'));
    
    const newCompta: Comptabilite = {
        ...data,
        id: comptaRef.id,
        createdAt: Date.now()
    };

    await setDoc(comptaRef, newCompta);

    // Add the creator as COMPTABLE
    const memberRef = doc(db, 'organizations', orgId, 'comptabilites', comptaRef.id, 'members', creatorUid);
    await setDoc(memberRef, {
        role: ComptaRole.COMPTABLE,
        uid: creatorUid,
        joinedAt: Date.now()
    });

    // Also update org member record if it exists
    try {
        const orgMemberRef = doc(db, 'organizations', orgId, 'members', creatorUid);
        const orgMemberSnap = await getDoc(orgMemberRef);
        if (orgMemberSnap.exists()) {
            await updateDoc(orgMemberRef, {
                [`comptaAccess.${comptaRef.id}`]: ComptaRole.COMPTABLE
            });
        }
    } catch (e) {
        console.warn("Could not update member comptaAccess:", e);
    }

    return comptaRef.id;
}

export const deleteComptabilite = async (orgId: string, comptaId: string): Promise<void> => {
    const db = getDb();
    
    // Recursive delete helper for subcollections
    const deleteSubcollection = async (sub: string) => {
        const snap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites', comptaId, sub));
        const batchDeletes = snap.docs.map(d => deleteDoc(d.ref));
        await Promise.all(batchDeletes);
    };

    // Delete known subcollections
    await deleteSubcollection('accounts');
    await deleteSubcollection('transactions');
    await deleteSubcollection('categories');
    await deleteSubcollection('members');

    // Delete the main compta document
    await deleteDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId));
}

export const toggleArchiveComptabilite = async (orgId: string, comptaId: string, isArchived: boolean): Promise<void> => {
    const db = getDb();
    const data: Partial<Comptabilite> = { isArchived };
    if (isArchived) {
        data.archivedAt = Date.now();
    } else {
        data.archivedAt = undefined;
    }
    await updateDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId), data);
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

export const approveInvitationWithAccess = async (
    orgId: string, 
    inviteId: string, 
    reviewerUid: string, 
    comptaAccess: Record<string, ComptaRole>
): Promise<void> => {
    const db = getDb();
    
    // Update invitation status
    const inviteRef = doc(db, 'organizations', orgId, 'invitations', inviteId);
    await updateDoc(inviteRef, { status: 'approved', reviewedBy: reviewerUid });
    
    // Add user to org members with comptaAccess
    const inviteSnap = await getDoc(inviteRef);
    if (inviteSnap.exists()) {
        const inviteData = inviteSnap.data() as Invitation;
        const displayName = `${inviteData.firstName || ''} ${inviteData.lastName || ''}`.trim() || inviteData.email.split('@')[0];
        
        await setMemberComptaAccess(
            orgId,
            inviteData.email,
            comptaAccess,
            OrgRole.MEMBER,
            displayName
        );

        if (inviteData.uid) {
            const memberRef = doc(db, 'organizations', orgId, 'members', inviteData.uid);
            await setDoc(memberRef, {
                uid: inviteData.uid,
                role: OrgRole.MEMBER,
                email: inviteData.email,
                firstName: inviteData.firstName,
                lastName: inviteData.lastName,
                customFields: inviteData.customFields || {},
                status: 'approved',
                joinedAt: Date.now(),
                approvedBy: reviewerUid,
                displayName,
                comptaAccess
            }, { merge: true });
        }
    }
};

export const rejectInvitation = async (orgId: string, inviteId: string, uid: string): Promise<void> => {
    const db = getDb();
    await updateDoc(doc(db, 'organizations', orgId, 'invitations', inviteId), { status: 'rejected', reviewedBy: uid });
};

export const getUserPendingInvitations = async (email: string): Promise<Array<{ orgId: string; orgName: string; inviteId: string; requestedAt: number }>> => {
    const db = getDb();
    const result: Array<{ orgId: string; orgName: string; inviteId: string; requestedAt: number }> = [];
    const normalizedEmail = email.trim().toLowerCase();

    try {
        const invitesQuery = query(collectionGroup(db, 'invitations'), where('email', '==', normalizedEmail), where('status', '==', 'pending'));
        const snap = await getDocs(invitesQuery);
        for (const d of snap.docs) {
            const data = d.data();
            const pathParts = d.ref.path.split('/');
            // organizations/{orgId}/invitations/{inviteId}
            if (pathParts.length >= 2) {
                const orgId = pathParts[1];
                const orgSnap = await getDoc(doc(db, 'organizations', orgId));
                result.push({
                    orgId,
                    orgName: orgSnap.exists() ? (orgSnap.data() as Organization).name : orgId,
                    inviteId: d.id,
                    requestedAt: data.requestedAt || Date.now()
                });
            }
        }
    } catch (e) {
        console.error("Error querying user pending invitations", e);
    }
    return result;
};

export const requestToJoinOrganization = async (
    orgId: string,
    user: { uid: string; email: string; displayName?: string; firstName?: string; lastName?: string },
    customFields: Record<string, string> = {}
): Promise<string> => {
    return createInvitation(orgId, {
        orgId,
        uid: user.uid,
        email: user.email,
        firstName: user.firstName || (user.displayName ? user.displayName.split(' ')[0] : ''),
        lastName: user.lastName || (user.displayName ? user.displayName.split(' ').slice(1).join(' ') : ''),
        customFields
    });
};

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

export const listAllOrganizations = async (): Promise<Organization[]> => {
    const db = getDb();
    const snapshot = await getDocs(collection(db, 'organizations'));
    return snapshot.docs.map(doc => doc.data() as Organization);
}

export const setMemberComptaAccess = async (
    orgId: string,
    email: string,
    comptaAccess: Record<string, ComptaRole>,
    role: OrgRole = OrgRole.MEMBER,
    displayName?: string,
    knownUid?: string
): Promise<void> => {
    const db = getDb();
    const normalizedEmail = email.trim().toLowerCase();
    
    // Check if user already exists in users collection
    let existingUid: string | undefined = knownUid || undefined;
    if (!existingUid) {
        const usersSnap = await getDocs(collection(db, 'users'));
        const matchedUser = usersSnap.docs.find(
            d => (d.data().email || '').trim().toLowerCase() === normalizedEmail
        );
        if (matchedUser) {
            existingUid = matchedUser.id;
        }
    }

    const memberDocId = existingUid || normalizedEmail;

    // If a pre-invited doc existed under email ID and now we have a UID, clean up the old email-keyed doc
    if (existingUid && existingUid !== normalizedEmail) {
        try {
            const legacyEmailRef = doc(db, 'organizations', orgId, 'members', normalizedEmail);
            const legacySnap = await getDoc(legacyEmailRef);
            if (legacySnap.exists()) {
                await deleteDoc(legacyEmailRef);
            }
        } catch (e) {
            console.warn("Could not clean up legacy email member doc:", e);
        }
    }

    // Save in organizations/{orgId}/members/{memberDocId}
    // First merge base fields, then explicitly overwrite comptaAccess so removed keys are not kept by deep-merge
    const memberRef = doc(db, 'organizations', orgId, 'members', memberDocId);
    await setDoc(memberRef, {
        email: normalizedEmail,
        uid: existingUid || null,
        role,
        status: 'approved',
        joinedAt: Date.now(),
        displayName: displayName || normalizedEmail.split('@')[0],
        comptaAccess
    }, { merge: true });
    await updateDoc(memberRef, { comptaAccess });

    // Sync compta members in subcollections (add active roles, remove revoked ones)
    if (existingUid) {
        const allComptasSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites'));
        for (const cDoc of allComptasSnap.docs) {
            const cId = cDoc.id;
            const cRole = comptaAccess[cId];
            const subMemberRef = doc(db, 'organizations', orgId, 'comptabilites', cId, 'members', existingUid);
            if (cRole && (cRole as string) !== 'none') {
                await setDoc(subMemberRef, {
                    uid: existingUid,
                    role: cRole,
                    email: normalizedEmail,
                    addedAt: Date.now()
                });
            } else {
                try {
                    await deleteDoc(subMemberRef);
                } catch (e) {
                    // Ignore if didn't exist
                }
            }
        }
    }
};

export const listOrganizationMembers = async (orgId: string): Promise<OrganizationMember[]> => {
    const db = getDb();
    const snapshot = await getDocs(collection(db, 'organizations', orgId, 'members'));
    return snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
    } as OrganizationMember));
};

export const removeOrganizationMember = async (orgId: string, memberId: string): Promise<void> => {
    const db = getDb();
    const memberRef = doc(db, 'organizations', orgId, 'members', memberId);
    const memberSnap = await getDoc(memberRef);
    const uid = memberSnap.exists() ? (memberSnap.data().uid || memberId) : memberId;

    await deleteDoc(memberRef);

    // Also revoke access in all comptabilites subcollections of this org
    try {
        const comptasSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites'));
        for (const cDoc of comptasSnap.docs) {
            await deleteDoc(doc(db, 'organizations', orgId, 'comptabilites', cDoc.id, 'members', uid));
        }
    } catch (e) {
        console.warn("Could not clean up compta subcollection members:", e);
    }
};

export const getUserOrganizations = async (uid: string, userEmail?: string): Promise<Organization[]> => {
    const db = getDb();
    const result: Organization[] = [];
    const seenOrgIds = new Set<string>();

    const normalizedEmail = userEmail?.trim().toLowerCase();

    try {
        const orgsSnap = await getDocs(collection(db, 'organizations'));
        for (const orgDoc of orgsSnap.docs) {
            const orgData = orgDoc.data() as Organization;
            const orgId = orgDoc.id;

            // 1. User is creator or designated admin by email
            const isCreator = orgData.createdBy === uid;
            const isAdminByEmail = normalizedEmail && orgData.adminEmail && orgData.adminEmail.trim().toLowerCase() === normalizedEmail;
            if (isCreator || isAdminByEmail) {
                seenOrgIds.add(orgId);
                result.push(orgData);
                continue;
            }

            // 2. Check organizations/{orgId}/members collection directly (no collectionGroup index required)
            const membersSnap = await getDocs(collection(db, 'organizations', orgId, 'members'));
            const isApprovedMember = membersSnap.docs.some(mDoc => {
                const m = mDoc.data();
                if (m.status === 'rejected' || m.status === 'pending') return false;
                const matchUid = mDoc.id === uid || m.uid === uid;
                const matchEmail = normalizedEmail && (
                    mDoc.id.toLowerCase() === normalizedEmail ||
                    (m.email && m.email.trim().toLowerCase() === normalizedEmail)
                );
                return matchUid || matchEmail;
            });

            if (isApprovedMember) {
                seenOrgIds.add(orgId);
                result.push(orgData);
                continue;
            }

            // 3. Check if user has direct access to at least one comptabilite in this org
            const comptasSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites'));
            for (const cDoc of comptasSnap.docs) {
                const cMemberSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', cDoc.id, 'members', uid));
                if (cMemberSnap.exists()) {
                    seenOrgIds.add(orgId);
                    result.push(orgData);
                    break;
                }
            }
        }
    } catch (error) {
        console.error("Error fetching user organizations: ", error);
    }
    return result;
};
