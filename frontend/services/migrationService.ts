import { collection, doc, getDocs, setDoc, getDoc } from 'firebase/firestore';
import { getDb, createOrganization, getOrganization } from './organizationService';
import { Comptabilite, ComptaRole, Organization } from '../types/rbac';

export interface LegacyDataSummary {
    hasData: boolean;
    accountsCount: number;
    transactionsCount: number;
    receiptsCount: number;
    hasAiConfig: boolean;
    source: 'firestore' | 'localStorage' | 'both' | 'none';
}

export const checkLegacyData = async (uid: string): Promise<LegacyDataSummary> => {
    // 1. One-shot migration check: if already flagged as done, do not prompt again
    if (localStorage.getItem('asso_compta_v1_migrated') === 'true') {
        return {
            hasData: false,
            accountsCount: 0,
            transactionsCount: 0,
            receiptsCount: 0,
            hasAiConfig: false,
            source: 'none'
        };
    }

    try {
        const db = getDb();
        const userDoc = await getDoc(doc(db, 'users', uid));
        if (userDoc.exists() && userDoc.data().v1MigrationDone) {
            localStorage.setItem('asso_compta_v1_migrated', 'true');
            return {
                hasData: false,
                accountsCount: 0,
                transactionsCount: 0,
                receiptsCount: 0,
                hasAiConfig: false,
                source: 'none'
            };
        }
    } catch (e) {
        console.warn("Could not check user doc for migration status", e);
    }

    let fsAccounts = 0;
    let fsTransactions = 0;
    let fsReceipts = 0;
    let fsAiConfig = false;

    try {
        const db = getDb();
        const accountsSnap = await getDocs(collection(db, 'users', uid, 'accounts'));
        fsAccounts = accountsSnap.size;
        const transactionsSnap = await getDocs(collection(db, 'users', uid, 'transactions'));
        fsTransactions = transactionsSnap.size;
        const receiptsSnap = await getDocs(collection(db, 'users', uid, 'receipts'));
        fsReceipts = receiptsSnap.size;
        const aiSnap = await getDoc(doc(db, 'users', uid, 'settings', 'aiConfig'));
        fsAiConfig = aiSnap.exists();
    } catch (error) {
        console.warn("Could not check Firestore legacy data:", error);
    }

    let localAccounts = 0;
    let localTransactions = 0;
    let localReceipts = 0;
    let localAiConfig = false;

    try {
        const rawAcc = localStorage.getItem('asso_compta_accounts_v5');
        if (rawAcc) localAccounts = JSON.parse(rawAcc).length || 0;
        const rawTxn = localStorage.getItem('asso_compta_transactions_v5');
        if (rawTxn) localTransactions = JSON.parse(rawTxn).length || 0;
        const rawRcpt = localStorage.getItem('asso_compta_receipts_v5');
        if (rawRcpt) localReceipts = JSON.parse(rawRcpt).length || 0;
        const rawAi = localStorage.getItem('asso_compta_ai_context_v5');
        if (rawAi && rawAi.trim().length > 0) localAiConfig = true;
    } catch (error) {
        console.warn("Could not check localStorage legacy data:", error);
    }

    const hasFs = fsAccounts > 0 || fsTransactions > 0 || fsReceipts > 0;
    const hasLocal = localAccounts > 0 || localTransactions > 0 || localReceipts > 0;

    let source: 'firestore' | 'localStorage' | 'both' | 'none' = 'none';
    if (hasFs && hasLocal) source = 'both';
    else if (hasFs) source = 'firestore';
    else if (hasLocal) source = 'localStorage';

    const accountsCount = Math.max(fsAccounts, localAccounts);
    const transactionsCount = Math.max(fsTransactions, localTransactions);
    const receiptsCount = Math.max(fsReceipts, localReceipts);
    const hasAiConfig = fsAiConfig || localAiConfig;

    return {
        hasData: hasFs || hasLocal,
        accountsCount,
        transactionsCount,
        receiptsCount,
        hasAiConfig,
        source
    };
};

export const checkHasLegacyData = async (uid: string): Promise<boolean> => {
    const summary = await checkLegacyData(uid);
    return summary.hasData;
};

export const migrateLegacyDataToOrg = async (uid: string, orgId: string, comptaName: string): Promise<string> => {
    const db = getDb();
    
    // 1. Create the new Comptabilité
    const comptaRef = doc(collection(db, 'organizations', orgId, 'comptabilites'));
    const comptaId = comptaRef.id;
    
    const newCompta: Comptabilite = {
        id: comptaId,
        name: comptaName,
        createdAt: Date.now(),
        currency: 'CHF'
    };
    
    await setDoc(comptaRef, newCompta);
    
    // 2. Add user as CAISSIER (and COMPTABLE) of this comptabilité
    const memberRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'members', uid);
    await setDoc(memberRef, {
        role: ComptaRole.CAISSIER,
        uid: uid,
        joinedAt: Date.now()
    });

    // 3. Migrate Accounts (Firestore or fallback to LocalStorage)
    const accountsSnap = await getDocs(collection(db, 'users', uid, 'accounts'));
    if (!accountsSnap.empty) {
        for (const docSnap of accountsSnap.docs) {
            const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'accounts', docSnap.id);
            await setDoc(targetRef, docSnap.data());
        }
    } else {
        const raw = localStorage.getItem('asso_compta_accounts_v5');
        if (raw) {
            try {
                const list = JSON.parse(raw);
                for (const acc of list) {
                    if (acc && acc.id) {
                        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'accounts', acc.id);
                        await setDoc(targetRef, acc);
                    }
                }
            } catch (e) {
                console.error("Error migrating localStorage accounts:", e);
            }
        }
    }

    // 4. Migrate Transactions (Firestore or fallback to LocalStorage)
    const transactionsSnap = await getDocs(collection(db, 'users', uid, 'transactions'));
    if (!transactionsSnap.empty) {
        for (const docSnap of transactionsSnap.docs) {
            const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'transactions', docSnap.id);
            await setDoc(targetRef, docSnap.data());
        }
    } else {
        const raw = localStorage.getItem('asso_compta_transactions_v5');
        if (raw) {
            try {
                const list = JSON.parse(raw);
                for (const txn of list) {
                    if (txn && txn.id) {
                        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'transactions', txn.id);
                        await setDoc(targetRef, txn);
                    }
                }
            } catch (e) {
                console.error("Error migrating localStorage transactions:", e);
            }
        }
    }

    // 5. Migrate Receipts (Firestore or fallback to LocalStorage)
    const receiptsSnap = await getDocs(collection(db, 'users', uid, 'receipts'));
    if (!receiptsSnap.empty) {
        for (const docSnap of receiptsSnap.docs) {
            const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'receipts', docSnap.id);
            await setDoc(targetRef, docSnap.data());
        }
    } else {
        const raw = localStorage.getItem('asso_compta_receipts_v5');
        if (raw) {
            try {
                const list = JSON.parse(raw);
                for (const rcpt of list) {
                    if (rcpt && rcpt.id) {
                        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'receipts', rcpt.id);
                        await setDoc(targetRef, rcpt);
                    }
                }
            } catch (e) {
                console.error("Error migrating localStorage receipts:", e);
            }
        }
    }

    // 6. Migrate AI Configuration
    const aiSnap = await getDoc(doc(db, 'users', uid, 'settings', 'aiConfig'));
    if (aiSnap.exists()) {
        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'settings', 'aiConfig');
        await setDoc(targetRef, aiSnap.data());
    } else {
        const rawAi = localStorage.getItem('asso_compta_ai_context_v5');
        if (rawAi) {
            const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'settings', 'aiConfig');
            await setDoc(targetRef, { context: rawAi });
        }
    }

    // 7. Migrate Categories (if any)
    const categoriesSnap = await getDocs(collection(db, 'users', uid, 'categories'));
    for (const docSnap of categoriesSnap.docs) {
        const targetRef = doc(db, 'organizations', orgId, 'comptabilites', comptaId, 'categories', docSnap.id);
        await setDoc(targetRef, docSnap.data());
    }

    // Mark migration as completed (one-shot)
    await markLegacyMigrationDone(uid);

    return comptaId;
};

export const markLegacyMigrationDone = async (uid: string): Promise<void> => {
    localStorage.setItem('asso_compta_v1_migrated', 'true');
    try {
        const db = getDb();
        await setDoc(doc(db, 'users', uid), {
            v1MigrationDone: true,
            v1MigratedAt: Date.now()
        }, { merge: true });
    } catch (e) {
        console.warn("Could not save migration done to Firestore:", e);
    }
};

export const connectCurrentCompta = async (
    user: { uid: string; email?: string | null },
    targetOrgId?: string,
    orgName: string = "Mon Association",
    comptaName: string = "Comptabilité principale"
): Promise<{ orgId: string; comptaId: string; org: Organization; compta: Comptabilite }> => {
    let finalOrgId = targetOrgId;
    let orgData: Organization | null = null;

    if (!finalOrgId) {
        finalOrgId = await createOrganization(
            orgName,
            "Organisation créée pour connecter la comptabilité existante",
            user.uid,
            user.email || undefined
        );
        orgData = await getOrganization(finalOrgId);
    } else {
        orgData = await getOrganization(finalOrgId);
    }

    if (!orgData) {
        throw new Error("Impossible de trouver l'organisation cible.");
    }

    const comptaId = await migrateLegacyDataToOrg(user.uid, finalOrgId, comptaName);
    await markLegacyMigrationDone(user.uid);

    const compta: Comptabilite = {
        id: comptaId,
        name: comptaName,
        createdAt: Date.now(),
        currency: 'CHF'
    };

    return { orgId: finalOrgId, comptaId, org: orgData, compta };
};
