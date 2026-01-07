/// <reference types="vite/client" />

// @ts-ignore
import { initializeApp, getApps, getApp } from 'firebase/app';
// @ts-ignore
import type { FirebaseApp } from 'firebase/app';
import {
    getFirestore, collection, doc, onSnapshot,
    setDoc, deleteDoc, updateDoc, query, orderBy, writeBatch, getDocs, deleteField
} from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import type { FirebaseStorage } from 'firebase/storage';
import { Account, Transaction, Receipt } from '../../types';
import { useState, useEffect } from 'react';
import type { User } from 'firebase/auth';

// --- CONFIGURATION FIREBASE SÉCURISÉE ---
// Les valeurs sont injectées par Vite (import.meta.env) au moment du build
// Elles ne sont plus hardcodées dans le fichier source.
const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// --- INITIALIZATION ---
export let app: FirebaseApp | undefined;
let db: Firestore;
let storage: FirebaseStorage;
let isConfigured = false;

try {
    // Vérification simple : si l'API Key est présente dans les env vars, on initialise
    if (firebaseConfig.apiKey) {
        if (!getApps().length) {
            app = initializeApp(firebaseConfig);
        } else {
            app = getApps()[0];
        }
        db = getFirestore(app);
        storage = getStorage(app);
        isConfigured = true;
    } else {
        console.warn("Firebase Config missing: Running in Offline Mode.");
    }
} catch (e) {
    console.error("Firebase init error:", e);
}

// --- HOOKS ---

export const useDataService = (user: User | null, isGuest: boolean = false) => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [transactions, setTransactions] = useState<Transaction[]>([]);
    const [receipts, setReceipts] = useState<Receipt[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const shouldUseLocalStorage = isGuest || !isConfigured;

    useEffect(() => {
        // CASE 1: Local Storage (Guest or Not Configured)
        if (shouldUseLocalStorage) {
            const savedAcc = localStorage.getItem('asso_compta_accounts_v5');
            const savedTxn = localStorage.getItem('asso_compta_transactions_v5');
            const savedRcpt = localStorage.getItem('asso_compta_receipts_v5');

            if (savedAcc) setAccounts(JSON.parse(savedAcc));
            if (savedTxn) setTransactions(JSON.parse(savedTxn));
            if (savedRcpt) setReceipts(JSON.parse(savedRcpt));

            setLoading(false);
            return;
        }

        // CASE 2: No User (and not guest) -> Clear Data
        if (!user) {
            setAccounts([]);
            setTransactions([]);
            setReceipts([]);
            setLoading(false);
            return;
        }

        // CASE 3: Firebase Firestore
        const unsubAccounts = onSnapshot(
            query(collection(db, "users", user.uid, "accounts"), orderBy("code")),
            (snapshot) => {
                const data = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Account));
                setAccounts(data);
            },
            (err) => setError(err.message)
        );

        const unsubTransactions = onSnapshot(
            query(collection(db, "users", user.uid, "transactions"), orderBy("date", "desc")),
            (snapshot) => {
                const data = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Transaction));
                setTransactions(data);
            },
            (err) => setError(err.message)
        );

        const unsubReceipts = onSnapshot(
            query(collection(db, "users", user.uid, "receipts"), orderBy("uploadDate", "desc")),
            (snapshot) => {
                const data = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Receipt));
                setReceipts(data);
                setLoading(false);
            },
            (err) => setError(err.message)
        );

        return () => {
            unsubAccounts();
            unsubTransactions();
            unsubReceipts();
        };
    }, [user, shouldUseLocalStorage]);

    // --- ACTIONS ---

    // Helper to sanitize objects for Firestore (removes undefined)
    const sanitize = <T extends object>(obj: T): T => {
        return JSON.parse(JSON.stringify(obj));
    };

    const saveAccount = async (account: Account) => {
        if (shouldUseLocalStorage) {
            setAccounts(prev => {
                const newAccs = prev.some(a => a.id === account.id)
                    ? prev.map(a => a.id === account.id ? account : a)
                    : [...prev, account];
                localStorage.setItem('asso_compta_accounts_v5', JSON.stringify(newAccs));
                return newAccs;
            });
            return;
        }
        if (user) {
            await setDoc(doc(db, "users", user.uid, "accounts", account.id), sanitize(account));
        }
    };

    const replaceAllAccounts = async (newAccounts: Account[]) => {
        if (shouldUseLocalStorage) {
            const safeAccounts = newAccounts.map(a => ({ ...a }));
            localStorage.setItem('asso_compta_accounts_v5', JSON.stringify(safeAccounts));
            setAccounts(safeAccounts);
            return;
        }
        if (user) {
            const batch = writeBatch(db);
            const snapshot = await getDocs(collection(db, "users", user.uid, "accounts"));
            const currentIds = snapshot.docs.map(d => d.id);
            const newIds = new Set(newAccounts.map(a => a.id));

            currentIds.forEach(id => {
                if (!newIds.has(id)) {
                    batch.delete(doc(db, "users", user.uid, "accounts", id));
                }
            });

            newAccounts.forEach(acc => {
                batch.set(doc(db, "users", user.uid, "accounts", acc.id), sanitize(acc));
            });

            await batch.commit();
        }
    };

    const deleteAccount = async (id: string) => {
        if (shouldUseLocalStorage) {
            setAccounts(prev => {
                const newAccs = prev.filter(a => a.id !== id);
                localStorage.setItem('asso_compta_accounts_v5', JSON.stringify(newAccs));
                return newAccs;
            });
            return;
        }
        if (user) {
            await deleteDoc(doc(db, "users", user.uid, "accounts", id));
        }
    };

    const saveTransaction = async (txn: Transaction) => {
        if (shouldUseLocalStorage) {
            setTransactions(prev => {
                const newTxns = prev.some(t => t.id === txn.id)
                    ? prev.map(t => t.id === txn.id ? txn : t)
                    : [...prev, txn];
                localStorage.setItem('asso_compta_transactions_v5', JSON.stringify(newTxns));
                return newTxns;
            });
            return;
        }
        if (user) {
            const cleanTxn = JSON.parse(JSON.stringify(txn));
            await setDoc(doc(db, "users", user.uid, "transactions", txn.id), cleanTxn);
        }
    };

    const saveTransactions = async (newTxnsList: Transaction[]) => {
        if (shouldUseLocalStorage) {
            setTransactions(prev => {
                const updated = [...prev];
                newTxnsList.forEach(newItem => {
                    const idx = updated.findIndex(t => t.id === newItem.id);
                    if (idx >= 0) {
                        updated[idx] = newItem;
                    } else {
                        updated.push(newItem);
                    }
                });
                localStorage.setItem('asso_compta_transactions_v5', JSON.stringify(updated));
                return updated;
            });
            return;
        }
        if (user) {
            const batch = writeBatch(db);
            newTxnsList.forEach(txn => {
                const cleanTxn = JSON.parse(JSON.stringify(txn));
                batch.set(doc(db, "users", user.uid, "transactions", txn.id), cleanTxn);
            });
            await batch.commit();
        }
    };

    const deleteTransaction = async (id: string) => {
        if (shouldUseLocalStorage) {
            setTransactions(prev => {
                const newTxns = prev.filter(t => t.id !== id);
                localStorage.setItem('asso_compta_transactions_v5', JSON.stringify(newTxns));
                return newTxns;
            });
            return;
        }
        if (user) {
            await deleteDoc(doc(db, "users", user.uid, "transactions", id));
        }
    };

    const deleteAllTransactions = async () => {
        if (shouldUseLocalStorage) {
            localStorage.removeItem('asso_compta_transactions_v5');
            setTransactions([]);

            // Unlink receipts in local storage
            setReceipts(prev => {
                const newR = prev.map(r => r.linkedTransactionId ? { ...r, linkedTransactionId: undefined } : r);
                localStorage.setItem('asso_compta_receipts_v5', JSON.stringify(newR));
                return newR;
            });
            return;
        }
        if (user) {
            const batch = writeBatch(db);

            // 1. Delete all transactions
            const qTxns = query(collection(db, "users", user.uid, "transactions"));
            const snapshotTxns = await getDocs(qTxns);
            snapshotTxns.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });

            // 2. Unlink all receipts that were linked
            const qReceipts = query(collection(db, "users", user.uid, "receipts"));
            const snapshotReceipts = await getDocs(qReceipts);
            snapshotReceipts.docs.forEach((doc) => {
                const data = doc.data();
                if (data.linkedTransactionId) {
                    batch.update(doc.ref, { linkedTransactionId: deleteField() });
                }
            });

            await batch.commit();
            // Local state update listener will handle UI update
        }
    };

    // --- RECEIPTS ACTIONS ---

    const saveReceipt = async (receipt: Receipt) => {
        if (shouldUseLocalStorage) {
            setReceipts(prev => {
                const newR = prev.some(r => r.id === receipt.id)
                    ? prev.map(r => r.id === receipt.id ? receipt : r)
                    : [...prev, receipt];
                localStorage.setItem('asso_compta_receipts_v5', JSON.stringify(newR));
                return newR;
            });
            return;
        }
        if (user) {
            await setDoc(doc(db, "users", user.uid, "receipts", receipt.id), receipt);
        }
    };

    const deleteReceipt = async (id: string) => {
        if (shouldUseLocalStorage) {
            setReceipts(prev => {
                const newR = prev.filter(r => r.id !== id);
                localStorage.setItem('asso_compta_receipts_v5', JSON.stringify(newR));
                return newR;
            });
            return;
        }
        if (user) {
            await deleteDoc(doc(db, "users", user.uid, "receipts", id));
        }
    }

    const uploadReceiptFile = async (file: File): Promise<string> => {
        // Helper: Convert File to Base64 (Data URL)
        const toBase64 = (f: File): Promise<string> => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.readAsDataURL(f);
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = error => reject(error);
            });
        };

        if (shouldUseLocalStorage) {
            return toBase64(file);
        }

        // Try Firebase Storage first
        try {
            const path = user
                ? `receipts/${user.uid}/${Date.now()}_${file.name}`
                : `receipts/public/${Date.now()}_${file.name}`;

            const storageRef = ref(storage, path);
            const snapshot = await uploadBytes(storageRef, file);
            return await getDownloadURL(snapshot.ref);
        } catch (error) {
            console.warn("Firebase Storage indisponible (non activé ?). Fallback sur Base64.", error);

            if (file.size > 800 * 1024) {
                throw new Error("Le stockage cloud n'est pas activé et l'image est trop lourde pour la base de données (Max 800Ko).");
            }

            return toBase64(file);
        }
    };

    return {
        accounts,
        transactions,
        receipts, // Exposed
        loading,
        error,
        isConfigured,
        saveAccount,
        replaceAllAccounts,
        deleteAccount,
        saveTransaction,
        saveTransactions,
        deleteTransaction,
        deleteAllTransactions,
        saveReceipt, // Exposed
        deleteReceipt, // Exposed
        uploadReceiptFile
    };
};