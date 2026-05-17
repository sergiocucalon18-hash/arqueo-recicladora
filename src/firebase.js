import { initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDHCRHB6vw42cyrwsiBQpYycYizQvISf0Q',
  authDomain: 'almetales-eadf3.firebaseapp.com',
  projectId: 'almetales-eadf3',
  storageBucket: 'almetales-eadf3.firebasestorage.app',
  messagingSenderId: '150362135650',
  appId: '1:150362135650:web:46ee84361ed56dabfa453b',
  measurementId: 'G-JJ54QJ47W4'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (typeof window !== 'undefined') {
  isSupported().then((supported) => {
    if (supported) getAnalytics(app);
  });
}
