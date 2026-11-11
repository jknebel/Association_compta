import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  type Unsubscribe,
} from 'firebase/firestore';
import { getFirestore } from 'firebase/firestore';
import { app } from './dataService';
import type { Rental, RentalStatus } from '../../types';
import type { User } from 'firebase/auth';

const getDb = () => {
  if (app) {
    return getFirestore(app);
  }
  return null;
};

export const subscribeRentals = (
  orgId: string,
  comptaId: string,
  onUpdate: (rentals: Rental[]) => void,
  onError?: (err: Error) => void
): Unsubscribe => {
  const cleanOrg = (orgId || 'TDGL').trim();
  const cleanCompta = (comptaId || 'default').trim();
  const db = getDb();

  if (!db) {
    onUpdate([]);
    return () => {};
  }

  const rentalsCollectionRef = collection(
    db,
    'organizations',
    cleanOrg,
    'comptabilites',
    cleanCompta,
    'rentals'
  );

  const q = query(rentalsCollectionRef, orderBy('createdAt', 'desc'));

  return onSnapshot(
    q,
    (snapshot) => {
      const items: Rental[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          orgId: typeof data.orgId === 'string' ? data.orgId : cleanOrg,
          comptaId: typeof data.comptaId === 'string' ? data.comptaId : cleanCompta,
          comptaName: typeof data.comptaName === 'string' ? data.comptaName : undefined,
          roomName: typeof data.roomName === 'string' ? data.roomName : 'Salle principale',
          renterName: typeof data.renterName === 'string' ? data.renterName : 'Locataire',
          renterPhone: typeof data.renterPhone === 'string' ? data.renterPhone : undefined,
          renterEmail: typeof data.renterEmail === 'string' ? data.renterEmail : undefined,
          startDate: typeof data.startDate === 'string' ? data.startDate : '',
          endDate: typeof data.endDate === 'string' ? data.endDate : undefined,
          amount: typeof data.amount === 'number' ? data.amount : Number(data.amount) || 0,
          status: (data.status as RentalStatus) || 'PENDING',
          notes: typeof data.notes === 'string' ? data.notes : undefined,
          paidAt: typeof data.paidAt === 'string' ? data.paidAt : null,
          paidByMethod: typeof data.paidByMethod === 'string' ? data.paidByMethod : null,
          paidMarkedByUid: typeof data.paidMarkedByUid === 'string' ? data.paidMarkedByUid : null,
          paidMarkedByName: typeof data.paidMarkedByName === 'string' ? data.paidMarkedByName : null,
          linkedTransactionId: typeof data.linkedTransactionId === 'string' ? data.linkedTransactionId : null,
          createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
          createdByUid: typeof data.createdByUid === 'string' ? data.createdByUid : '',
          createdByName: typeof data.createdByName === 'string' ? data.createdByName : '',
        };
      });

      onUpdate(items);
    },
    (err) => {
      console.error('Erreur souscription locations web :', err);
      if (onError) onError(err);
    }
  );
};

export const markRentalAsPaidWeb = async (
  orgId: string,
  comptaId: string,
  rentalId: string,
  paymentMethod: string = 'Virement',
  user: User | null,
  userName?: string
): Promise<void> => {
  const cleanOrg = (orgId || 'TDGL').trim();
  const cleanCompta = (comptaId || 'default').trim();
  const db = getDb();
  if (!db) return;

  const docRef = doc(db, 'organizations', cleanOrg, 'comptabilites', cleanCompta, 'rentals', rentalId);
  await updateDoc(docRef, {
    status: 'PAID' as RentalStatus,
    paidAt: new Date().toISOString(),
    paidByMethod: paymentMethod,
    paidMarkedByUid: user?.uid || 'caissier',
    paidMarkedByName: userName || user?.displayName || user?.email || 'Caissier',
  });
};

export const linkRentalToTransactionWeb = async (
  orgId: string,
  comptaId: string,
  rentalId: string,
  transactionId: string,
  user?: User | null,
  userName?: string
): Promise<void> => {
  const cleanOrg = (orgId || 'TDGL').trim();
  const cleanCompta = (comptaId || 'default').trim();
  const db = getDb();
  if (!db) return;

  const docRef = doc(db, 'organizations', cleanOrg, 'comptabilites', cleanCompta, 'rentals', rentalId);
  await updateDoc(docRef, {
    linkedTransactionId: transactionId,
    status: 'PAID' as RentalStatus,
    paidAt: new Date().toISOString(),
    paidByMethod: 'Virement',
    visaDate: new Date().toISOString(),
    visaByUid: user?.uid || 'caissier',
    visaByName: userName || user?.displayName || user?.email || 'Caissier',
    paidMarkedByUid: user?.uid || 'caissier',
    paidMarkedByName: userName || user?.displayName || user?.email || 'Caissier',
  });
};

export const unlinkRentalFromTransactionWeb = async (
  orgId: string,
  comptaId: string,
  rentalId: string
): Promise<void> => {
  const cleanOrg = (orgId || 'TDGL').trim();
  const cleanCompta = (comptaId || 'default').trim();
  const db = getDb();
  if (!db) return;

  const docRef = doc(db, 'organizations', cleanOrg, 'comptabilites', cleanCompta, 'rentals', rentalId);
  await updateDoc(docRef, {
    linkedTransactionId: null,
    visaDate: null,
    visaByUid: null,
    visaByName: null,
  });
};

export const markRentalAsPendingWeb = async (
  orgId: string,
  comptaId: string,
  rentalId: string
): Promise<void> => {
  const cleanOrg = (orgId || 'TDGL').trim();
  const cleanCompta = (comptaId || 'default').trim();
  const db = getDb();
  if (!db) return;

  const docRef = doc(db, 'organizations', cleanOrg, 'comptabilites', cleanCompta, 'rentals', rentalId);
  await updateDoc(docRef, {
    status: 'PENDING' as RentalStatus,
    paidAt: null,
    paidByMethod: null,
    paidMarkedByUid: null,
    paidMarkedByName: null,
  });
};

export const createRentalWeb = async (
  orgId: string,
  comptaId: string,
  data: Partial<Rental>,
  user: User | null,
  userName?: string
): Promise<Rental> => {
  const cleanOrg = (orgId || 'TDGL').trim();
  const cleanCompta = (comptaId || 'default').trim();
  const db = getDb();
  const rentalId = `rental-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const newRental: Rental = {
    id: rentalId,
    orgId: cleanOrg,
    comptaId: cleanCompta,
    roomName: data.roomName?.trim() || 'Grande salle',
    renterName: data.renterName?.trim() || 'Locataire',
    renterPhone: data.renterPhone?.trim() || '',
    renterEmail: data.renterEmail?.trim() || '',
    startDate: data.startDate || new Date().toISOString().split('T')[0],
    endDate: data.endDate || data.startDate || new Date().toISOString().split('T')[0],
    amount: Number(data.amount) || 0,
    status: 'PENDING',
    notes: data.notes?.trim() || '',
    paidAt: null,
    paidByMethod: null,
    paidMarkedByUid: null,
    paidMarkedByName: null,
    linkedTransactionId: null,
    createdAt: new Date().toISOString(),
    createdByUid: user?.uid || '',
    createdByName: userName || user?.displayName || user?.email || 'Admin',
  };

  if (db) {
    const firestoreData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(newRental)) {
      if (v !== undefined) {
        firestoreData[k] = v;
      }
    }
    const docRef = doc(db, 'organizations', cleanOrg, 'comptabilites', cleanCompta, 'rentals', rentalId);
    await setDoc(docRef, firestoreData);
  }

  return newRental;
};

export const deleteRentalWeb = async (
  orgId: string,
  comptaId: string,
  rentalId: string
): Promise<void> => {
  const cleanOrg = (orgId || 'TDGL').trim();
  const cleanCompta = (comptaId || 'default').trim();
  const db = getDb();
  if (!db) return;

  const docRef = doc(db, 'organizations', cleanOrg, 'comptabilites', cleanCompta, 'rentals', rentalId);
  await deleteDoc(docRef);
};
