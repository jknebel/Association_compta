import { collection, collectionGroup, doc, setDoc, getDoc, updateDoc, deleteDoc, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { getFirestore } from 'firebase/firestore';
import { app } from './dataService';
import { Organization, Comptabilite, CustomField, Invitation, OrgRole, ComptaRole, OrganizationMember } from '../types/rbac';
import { Account, AccountType, Transaction, TransactionStatus } from '../../types';

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
        return { ...(docSnap.data() as Organization), id: docSnap.id };
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

export const renameComptabilite = async (
    orgId: string,
    comptaId: string,
    newName: string,
    newDescription?: string
): Promise<void> => {
    const db = getDb();
    const updates: Record<string, any> = { name: newName.trim() };
    if (newDescription !== undefined) {
        updates.description = newDescription.trim();
    }
    await updateDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId), updates);
};

export const suggestNextComptaName = (currentName: string): {
    baseName: string;
    detectedPeriod: string;
    suggestedNextPeriod: string;
    suggestedFullName: string;
} => {
    const trimmed = (currentName || '').trim();
    // Match trailing pattern like "25/26", "25-26", "2025/2026", "2025-2026"
    const dualYearMatch = trimmed.match(/^(.*?)\s*(\d{2,4})\s*([\/\-])\s*(\d{2,4})$/);
    if (dualYearMatch) {
        const baseName = dualYearMatch[1].trim() || trimmed;
        const y1Str = dualYearMatch[2];
        const sep = dualYearMatch[3];
        const y2Str = dualYearMatch[4];
        const y1 = parseInt(y1Str, 10);
        const y2 = parseInt(y2Str, 10);
        const nextY1 = (y1 + 1).toString().padStart(y1Str.length, '0');
        const nextY2 = (y2 + 1).toString().padStart(y2Str.length, '0');
        const detectedPeriod = `${y1Str}${sep}${y2Str}`;
        const suggestedNextPeriod = `${nextY1}/${nextY2}`;
        return {
            baseName,
            detectedPeriod,
            suggestedNextPeriod,
            suggestedFullName: `${baseName} ${suggestedNextPeriod}`.trim()
        };
    }

    // Match trailing single year like "2025" or "25"
    const singleYearMatch = trimmed.match(/^(.*?)\s+(\d{4}|\d{2})$/);
    if (singleYearMatch && singleYearMatch[1].trim()) {
        const baseName = singleYearMatch[1].trim();
        const yStr = singleYearMatch[2];
        const y = parseInt(yStr, 10);
        const nextY1 = yStr.length === 4 ? (y % 100) : y;
        const nextY2 = nextY1 + 1;
        const suggestedNextPeriod = `${String(nextY1).padStart(2, '0')}/${String(nextY2).padStart(2, '0')}`;
        return {
            baseName,
            detectedPeriod: yStr,
            suggestedNextPeriod,
            suggestedFullName: `${baseName} ${suggestedNextPeriod}`.trim()
        };
    }

    // No year in current name (e.g. "Groupe", "Louveteaux")
    const nowYear = new Date().getFullYear() % 100;
    const suggestedNextPeriod = `${String(nowYear).padStart(2, '0')}/${String(nowYear + 1).padStart(2, '0')}`;
    return {
        baseName: trimmed || 'Comptabilité',
        detectedPeriod: '',
        suggestedNextPeriod,
        suggestedFullName: `${trimmed || 'Comptabilité'} ${suggestedNextPeriod}`.trim()
    };
};

export const getComptaBalanceSummary = async (orgId: string, comptaId: string): Promise<{
    openingBalance: number;
    totalIncome: number;
    totalExpense: number;
    totalMovements: number;
    closingBalance: number;
    transactionsCount: number;
    accountsCount: number;
}> => {
    const db = getDb();
    const accountsSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites', comptaId, 'accounts'));
    const txnsSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites', comptaId, 'transactions'));

    const accounts = accountsSnap.docs.map(d => d.data() as Account);
    const transactions = txnsSnap.docs.map(d => d.data() as Transaction);
    const activeTxns = transactions.filter(t => t.status !== TransactionStatus.ARCHIVED);

    const assetAcc = accounts.find(a => a.type === AccountType.ASSET);
    const openingBalance = Number(assetAcc?.initialBalance || 0);

    const totalIncome = activeTxns.filter(t => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = activeTxns.filter(t => Number(t.amount) < 0).reduce((s, t) => s + Number(t.amount), 0);
    const totalMovements = totalIncome + totalExpense;

    const rawClosing = assetAcc?.closingBalance !== undefined
        ? Number(assetAcc.closingBalance)
        : openingBalance + totalMovements;
    const closingBalance = Math.round(rawClosing * 100) / 100;

    return {
        openingBalance: Math.round(openingBalance * 100) / 100,
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpense: Math.round(totalExpense * 100) / 100,
        totalMovements: Math.round(totalMovements * 100) / 100,
        closingBalance,
        transactionsCount: activeTxns.length,
        accountsCount: accounts.length
    };
};

export const closeAndRolloverComptabilite = async (options: {
    orgId: string;
    oldComptaId: string;
    newComptaName: string;
    closingDate: string;
    carryOverBalance: number;
    creatorUid: string;
    overrideAccounts?: Account[];
}): Promise<Comptabilite> => {
    const { orgId, oldComptaId, newComptaName, closingDate, carryOverBalance, creatorUid, overrideAccounts } = options;
    const db = getDb();

    const oldComptaRef = doc(db, 'organizations', orgId, 'comptabilites', oldComptaId);
    const oldComptaSnap = await getDoc(oldComptaRef);
    const oldComptaData = oldComptaSnap.exists() ? (oldComptaSnap.data() as Comptabilite) : null;

    // 1. Archive the old comptabilité with closing date
    await updateDoc(oldComptaRef, {
        isArchived: true,
        archivedAt: Date.now(),
        fiscalYearEnd: closingDate
    });

    // 2. Create the new comptabilité
    const newComptaRef = doc(collection(db, 'organizations', orgId, 'comptabilites'));
    const newComptaId = newComptaRef.id;
    const newCompta: Comptabilite = {
        id: newComptaId,
        name: newComptaName.trim(),
        description: oldComptaData?.description || '',
        createdAt: Date.now(),
        createdBy: creatorUid,
        fiscalYearStart: closingDate,
        fiscalYearEnd: '',
        currency: oldComptaData?.currency || 'CHF',
        isArchived: false
    };
    await setDoc(newComptaRef, newCompta);

    // 3. Copy accounts into the new comptabilité with carried-over initial balance on ASSET account
    let sourceAccounts: Account[] = [];
    if (overrideAccounts && overrideAccounts.length > 0) {
        sourceAccounts = overrideAccounts;
    } else {
        const accSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites', oldComptaId, 'accounts'));
        sourceAccounts = accSnap.docs.map(d => d.data() as Account);
    }

    const roundedCarryOver = Math.round(Number(carryOverBalance || 0) * 100) / 100;
    const hasAssetAccount = sourceAccounts.some(a => a.type === AccountType.ASSET);

    const accountsBatch = writeBatch(db);
    let primaryAssetHandled = false;

    for (const acc of sourceAccounts) {
        const cleanAcc: Record<string, any> = { ...acc };
        delete cleanAcc.closingBalance;

        if (acc.type === AccountType.ASSET && !primaryAssetHandled) {
            primaryAssetHandled = true;
            cleanAcc.initialBalance = roundedCarryOver;
            // Also record closingBalance on old compta's asset account for historical clarity
            const oldAccRef = doc(db, 'organizations', orgId, 'comptabilites', oldComptaId, 'accounts', acc.id);
            accountsBatch.set(oldAccRef, { ...acc, closingBalance: roundedCarryOver }, { merge: true });
        } else if (acc.type === AccountType.LIABILITY) {
            cleanAcc.initialBalance = Number(acc.initialBalance || 0);
        } else {
            // Reset INCOME, EXPENSE, MIXED accounts to 0 for the new fiscal year
            cleanAcc.initialBalance = 0;
        }

        // Remove undefined fields before writing to Firestore
        Object.keys(cleanAcc).forEach(k => {
            if (cleanAcc[k] === undefined) delete cleanAcc[k];
        });

        const newAccRef = doc(db, 'organizations', orgId, 'comptabilites', newComptaId, 'accounts', acc.id);
        accountsBatch.set(newAccRef, cleanAcc);
    }

    if (!hasAssetAccount) {
        const defaultAssetId = 'acc_bank_' + Date.now();
        const defaultAsset: Account = {
            id: defaultAssetId,
            code: '1020',
            label: 'Compte Bancaire',
            description: 'Compte de trésorerie principal',
            type: AccountType.ASSET,
            isMembership: false,
            initialBalance: roundedCarryOver
        };
        const newAccRef = doc(db, 'organizations', orgId, 'comptabilites', newComptaId, 'accounts', defaultAssetId);
        accountsBatch.set(newAccRef, defaultAsset);
    }

    await accountsBatch.commit();

    // 4. Copy AI settings if present
    try {
        const oldAiSnap = await getDoc(doc(db, 'organizations', orgId, 'comptabilites', oldComptaId, 'settings', 'aiConfig'));
        if (oldAiSnap.exists()) {
            await setDoc(doc(db, 'organizations', orgId, 'comptabilites', newComptaId, 'settings', 'aiConfig'), oldAiSnap.data());
        }
    } catch (e) {
        console.warn("Could not copy aiConfig to new compta:", e);
    }

    // 5. Copy member access from old compta to new compta
    try {
        const oldSubMembersSnap = await getDocs(collection(db, 'organizations', orgId, 'comptabilites', oldComptaId, 'members'));
        for (const mDoc of oldSubMembersSnap.docs) {
            await setDoc(doc(db, 'organizations', orgId, 'comptabilites', newComptaId, 'members', mDoc.id), {
                ...mDoc.data(),
                addedAt: Date.now()
            });
        }
        // Ensure creator has access
        await setDoc(doc(db, 'organizations', orgId, 'comptabilites', newComptaId, 'members', creatorUid), {
            role: ComptaRole.CAISSIER,
            uid: creatorUid,
            joinedAt: Date.now()
        }, { merge: true });

        // Update comptaAccess map on organization members who had access to oldComptaId
        const orgMembersSnap = await getDocs(collection(db, 'organizations', orgId, 'members'));
        for (const orgMemDoc of orgMembersSnap.docs) {
            const memData = orgMemDoc.data();
            const existingRole = memData.comptaAccess?.[oldComptaId];
            if (existingRole) {
                await updateDoc(orgMemDoc.ref, {
                    [`comptaAccess.${newComptaId}`]: existingRole
                });
            } else if (orgMemDoc.id === creatorUid || memData.uid === creatorUid) {
                await updateDoc(orgMemDoc.ref, {
                    [`comptaAccess.${newComptaId}`]: ComptaRole.CAISSIER
                });
            }
        }
    } catch (e) {
        console.warn("Could not copy member permissions to new compta:", e);
    }

    return newCompta;
};

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
    const data: Record<string, any> = { isArchived };
    if (isArchived) {
        data.archivedAt = Date.now();
    } else {
        data.archivedAt = 0;
    }
    await updateDoc(doc(db, 'organizations', orgId, 'comptabilites', comptaId), data);
}

export const listComptabilites = async (orgId: string): Promise<Comptabilite[]> => {
    const db = getDb();
    const snapshot = await getDocs(collection(db, 'organizations', orgId, 'comptabilites'));
    return snapshot.docs.map(doc => ({ ...(doc.data() as Comptabilite), id: doc.id }));
}

export const generateInviteLink = async (orgId: string, forceNew = false): Promise<string> => {
    const db = getDb();
    if (!forceNew) {
        const org = await getOrganization(orgId);
        if (org?.inviteCode) {
            return org.inviteCode;
        }
    }
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
    const [invSnap, membersSnap] = await Promise.all([
        getDocs(query(collection(db, 'organizations', orgId, 'invitations'), where('status', '==', 'pending'))),
        getDocs(collection(db, 'organizations', orgId, 'members'))
    ]);

    const approvedEmails = new Set<string>();
    const approvedUids = new Set<string>();
    membersSnap.docs.forEach(mDoc => {
        const m = mDoc.data();
        if (m.status !== 'rejected' && m.status !== 'pending') {
            if (m.email) approvedEmails.add(String(m.email).trim().toLowerCase());
            if (m.uid) approvedUids.add(String(m.uid));
            approvedUids.add(mDoc.id);
            approvedEmails.add(mDoc.id.toLowerCase());
        }
    });

    const pendingInvites: Invitation[] = [];
    for (const invDoc of invSnap.docs) {
        const inv = { ...(invDoc.data() as Invitation), id: invDoc.id };
        const invEmail = (inv.email || '').trim().toLowerCase();
        const isAlreadyApproved =
            (invEmail && approvedEmails.has(invEmail)) ||
            (inv.uid && approvedUids.has(inv.uid));

        if (isAlreadyApproved) {
            // Auto-clean stale pending invitation for a member who was already validated via direct role assignment
            try {
                await updateDoc(invDoc.ref, { status: 'approved' });
            } catch (e) {
                console.warn("Could not auto-approve stale invitation:", e);
            }
        } else {
            pendingInvites.push(inv);
        }
    }

    return pendingInvites;
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
    return snapshot.docs.map(doc => ({ ...(doc.data() as Organization), id: doc.id }));
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

    // Enforce maximum 2 admins per organization
    if (role === OrgRole.ADMIN || (role as string) === 'admin') {
        const currentMembersSnap = await getDocs(collection(db, 'organizations', orgId, 'members'));
        const otherAdminEmails = new Set<string>();
        for (const mDoc of currentMembersSnap.docs) {
            const mData = mDoc.data();
            if (mData.role === OrgRole.ADMIN && mData.status !== 'rejected') {
                const mEmail = (mData.email || '').trim().toLowerCase();
                const mUid = mData.uid || mDoc.id;
                const isSameUser =
                    (mEmail && mEmail === normalizedEmail) ||
                    (existingUid && mUid === existingUid) ||
                    mDoc.id === memberDocId;
                if (!isSameUser) {
                    otherAdminEmails.add(mEmail || mUid);
                }
            }
        }
        if (otherAdminEmails.size >= 2) {
            throw new Error("Limite atteinte : il ne peut y avoir que 2 administrateurs maximum par association.");
        }
    }

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

    // Auto-approve any pending invitation for this user so 'en attente' badge disappears immediately
    try {
        const pendingSnap = await getDocs(query(collection(db, 'organizations', orgId, 'invitations'), where('status', '==', 'pending')));
        for (const invDoc of pendingSnap.docs) {
            const invData = invDoc.data();
            const matchEmail = (invData.email || '').trim().toLowerCase() === normalizedEmail;
            const matchUid = existingUid && invData.uid === existingUid;
            if (matchEmail || matchUid) {
                await updateDoc(invDoc.ref, { status: 'approved' });
            }
        }
    } catch (e) {
        console.warn("Could not auto-approve pending invitations:", e);
    }
};

export const setSingleComptaMemberAccess = async (
    orgId: string,
    comptaId: string,
    email: string,
    comptaRole: ComptaRole | 'none',
    displayName?: string,
    knownUid?: string
): Promise<void> => {
    const db = getDb();
    const normalizedEmail = email.trim().toLowerCase();

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
    const memberRef = doc(db, 'organizations', orgId, 'members', memberDocId);
    const existingMemberSnap = await getDoc(memberRef);

    let currentComptaAccess: Record<string, ComptaRole> = {};
    let existingOrgRole: OrgRole = OrgRole.MEMBER;
    let existingDisplayName = displayName || normalizedEmail.split('@')[0];

    if (existingMemberSnap.exists()) {
        const data = existingMemberSnap.data();
        currentComptaAccess = { ...(data.comptaAccess || {}) };
        existingOrgRole = data.role || OrgRole.MEMBER;
        existingDisplayName = displayName || data.displayName || existingDisplayName;
    } else if (existingUid && existingUid !== normalizedEmail) {
        const legacyEmailRef = doc(db, 'organizations', orgId, 'members', normalizedEmail);
        const legacySnap = await getDoc(legacyEmailRef);
        if (legacySnap.exists()) {
            const data = legacySnap.data();
            currentComptaAccess = { ...(data.comptaAccess || {}) };
            existingOrgRole = data.role || OrgRole.MEMBER;
            existingDisplayName = displayName || data.displayName || existingDisplayName;
            try {
                await deleteDoc(legacyEmailRef);
            } catch (e) {
                // ignore
            }
        }
    }

    if (comptaRole === 'none') {
        delete currentComptaAccess[comptaId];
    } else {
        currentComptaAccess[comptaId] = comptaRole;
    }

    await setDoc(memberRef, {
        email: normalizedEmail,
        uid: existingUid || null,
        role: existingOrgRole,
        status: 'approved',
        joinedAt: existingMemberSnap.exists() ? (existingMemberSnap.data().joinedAt || Date.now()) : Date.now(),
        displayName: existingDisplayName,
        comptaAccess: currentComptaAccess
    }, { merge: true });
    await updateDoc(memberRef, { comptaAccess: currentComptaAccess });

    if (existingUid) {
        const subMemberRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'members', existingUid);
        if (comptaRole !== 'none') {
            await setDoc(subMemberRef, {
                uid: existingUid,
                role: comptaRole,
                email: normalizedEmail,
                addedAt: Date.now()
            });
        } else {
            try {
                await deleteDoc(subMemberRef);
            } catch (e) {
                // ignore
            }
        }
    }

    // Auto-approve any pending invitation for this user
    try {
        const pendingSnap = await getDocs(query(collection(db, 'organizations', orgId, 'invitations'), where('status', '==', 'pending')));
        for (const invDoc of pendingSnap.docs) {
            const invData = invDoc.data();
            const matchEmail = (invData.email || '').trim().toLowerCase() === normalizedEmail;
            const matchUid = existingUid && invData.uid === existingUid;
            if (matchEmail || matchUid) {
                await updateDoc(invDoc.ref, { status: 'approved' });
            }
        }
    } catch (e) {
        console.warn("Could not auto-approve pending invitations:", e);
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
            const orgData = { ...(orgDoc.data() as Organization), id: orgDoc.id };
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
