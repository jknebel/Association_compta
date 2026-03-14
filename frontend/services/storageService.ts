
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

// Standalone upload function that includes a robust fallback
// This ensures that if Storage is not enabled in Firebase Console, 
// the app doesn't crash but saves the image as a Base64 string in Firestore.

// Helper to compute SHA-256 hash of a file for deduplication
const computeHash = async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

export const uploadReceipt = async (file: File): Promise<string> => {
    // Helper for Base64 (Internal fallback)
    const toBase64 = (f: File): Promise<string> => {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(f);
        });
    };

    try {
        const storage = getStorage();
        const hash = await computeHash(file);
        // Use hash in path to ensure that identical content results in the same URL
        const storageRef = ref(storage, `receipts/${hash}_${file.name}`);

        // Dedup: Check if file already exists
        try {
            const existingUrl = await getDownloadURL(storageRef);
            console.log("File already exists in Storage, reusing URL:", file.name);
            return existingUrl;
        } catch (err) {
            // Not found or error, proceed with upload
        }

        const snapshot = await uploadBytes(storageRef, file);
        return await getDownloadURL(snapshot.ref);
    } catch (e) {
        console.warn("Firebase Storage fallback logic (Base64):", e);

        // Limit check: 10MB for Storage, but Firestore doc is 1MB.
        if (file.size > 10 * 1024 * 1024) {
            throw new Error(`Le fichier ${file.name} est trop volumineux (> 10Mo).`);
        }

        if (file.size > 800 * 1024) {
            throw new Error(`Le fichier ${file.name} fait ${(file.size / 1024).toFixed(0)}Ko. \n\nERREUR : Firebase Storage n'est pas configuré ou est inaccessible.\n\nLe mode local est limité à 1Mo. Activez Firebase Storage pour accepter jusqu'à 10Mo.`);
        }

        return toBase64(file);
    }
};

export const deleteFileFromStorage = async (url: string): Promise<void> => {
    if (!url || typeof url !== 'string') return;

    // Only attempt to delete if it's a Firebase Storage URL
    // Firebase URLs typically look like: https://firebasestorage.googleapis.com/...
    if (!url.includes('firebasestorage.googleapis.com')) {
        console.log("Not a Firebase Storage URL (likely Base64 or local), skipping file deletion.");
        return;
    }

    try {
        const storage = getStorage();
        // Extract path from URL or use ref(storage, url) if supported by the modular SDK version
        // Actually, ref(storage, url) works for download URLs in modular SDK.
        const storageRef = ref(storage, url);
        await deleteObject(storageRef);
        console.log("File deleted from Storage:", url);
    } catch (e) {
        console.error("Error deleting file from Storage:", e);
        // We don't throw here to avoid blocking the document deletion if the file is already gone
    }
};
