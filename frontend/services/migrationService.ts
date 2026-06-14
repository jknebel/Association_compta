import { collection, doc, getDocs, setDoc, getDoc } from 'firebase/firestore';
import { getDb } from './organizationService';
import { Comptabilite, ComptaRole } from '../types/rbac';

export const checkHasLegacyData = async (uid: string): Promise<boolean> => {
    try {
        const db = getDb();
        const accountsSnap = await getDocs(collection(db, 'users', uid, 'accounts'));
        const transactionsSnap = await getDocs(collection(db, 'users', uid, 'transactions'));
        return !accountsSnap.empty || !transactionsSnap.empty;
    } catch (error) {
        console.error("Error checking legacy data:", error);
        return false;
    }
};

export const migrateLegacyDataToOrg = async (uid: string, orgId: string, comptaName: string): Promise<string> => {
    const db = getDb();
    
    // 1. Create the new Comptabilité
    const comptaRef = doc(collection(db, 'organizations', orgId, 'comptabilites'));
    const comptaId = comptaRef.id;
    
    const newCompta: Comptabilite = {
        id: comptaId,
        name: comptaName,
        createdAt: Date.now()
    };
    
    await setDoc(comptaRef, newCompta);
    
    // 2. Add user as ADMIN of this comptabilité
    const memberRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'members', uid);
    await setDoc(memberRef, {
        role: ComptaRole.ADMIN,
        uid: uid,
        joinedAt: Date.now()
    });

    // 3. Migrate Accounts
    const accountsSnap = await getDocs(collection(db, 'users', uid, 'accounts'));
    for (const docSnap of accountsSnap.docs) {
        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'accounts', docSnap.id);
        await setDoc(targetRef, docSnap.data());
    }

    // 4. Migrate Transactions
    const transactionsSnap = await getDocs(collection(db, 'users', uid, 'transactions'));
    for (const docSnap of transactionsSnap.docs) {
        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'transactions', docSnap.id);
        await setDoc(targetRef, docSnap.data());
    }

    // 5. Migrate Categories (if they exist)
    const categoriesSnap = await getDocs(collection(db, 'users', uid, 'categories'));
    for (const docSnap of categoriesSnap.docs) {
        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'categories', docSnap.id);
        await setDoc(targetRef, docSnap.data());
    }

    // 6. Optional: receipts are in storage, we can't easily move them from client SDK
    // For Phase 2, we just keep their path in the transaction doc. 
    // The transaction doc already has `receiptUrl` which points to the old path or the public URL.
    // So no storage migration is strictly needed for URLs.

    return comptaId;
};
