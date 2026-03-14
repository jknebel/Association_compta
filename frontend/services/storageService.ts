
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

// Standalone upload function that includes a robust fallback
// This ensures that if Storage is not enabled in Firebase Console, 
// the app doesn't crash but saves the image as a Base64 string in Firestore.

export const uploadReceipt = async (file: File): Promise<string> => {
   // Helper for Base64
   const toBase64 = (f: File): Promise<string> => {
       return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
   };

   try {
       // Check if Firebase is globally initialized (window level or just try getting storage)
       // If getStorage throws, it means no App.
       const storage = getStorage(); 
       const storageRef = ref(storage, `receipts/${Date.now()}_${file.name}`);
       const snapshot = await uploadBytes(storageRef, file);
       return await getDownloadURL(snapshot.ref);
   } catch (e) {
       console.warn("Firebase Storage not available or failed (Fallback to Base64):", e);
       
        // Limit check: 10MB is common for attachments/receipts.
        // NOTE: Firestore document limit is 1MB. If the file is > 1MB, the Base64 fallback will fail later.
        if (file.size > 10 * 1024 * 1024) {
            throw new Error(`Le fichier ${file.name} est trop volumineux (> 10Mo).`);
        }
        
        if (file.size > 800 * 1024) {
             throw new Error(`Le fichier ${file.name} fait ${(file.size / 1024).toFixed(0)}Ko. \n\nERREUR : Firebase Storage n'est pas configuré ou est inaccessible (Erreur 403/404).\n\nLe mode local (sans Storage) est limité à 1Mo par fichier. Veuillez activer Firebase Storage dans votre console pour accepter des fichiers jusqu'à 10Mo.`);
        }
       
       return toBase64(file);
   }
};

export const deleteReceipt = async (url: string): Promise<void> => {
    // Implementing delete is complex with mixed types (Storage vs Base64)
    // For now we just return resolved, as deleting the URL from the transaction is enough to "orphan" it.
    return Promise.resolve();
};
