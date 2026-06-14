import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const firebaseConfig = {
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function test() {
    try {
        console.log("Testing write to /organizations/test_org_id...");
        await setDoc(doc(db, 'organizations', 'test_org_id'), { test: true });
        console.log("Write SUCCESS. Rules are deployed and open.");
    } catch (e) {
        console.error("Write FAILED. Error:", e.message);
    }
    process.exit();
}

test();
