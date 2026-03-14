import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAW50XInUSYmSsT0ww1YZafU2bZlJeOnLc",
  authDomain: "knowledgeking-a7209.firebaseapp.com",
  databaseURL: "https://knowledgeking-a7209-default-rtdb.firebaseio.com",
  projectId: "knowledgeking-a7209",
  storageBucket: "knowledgeking-a7209.firebasestorage.app",
  messagingSenderId: "121602685475",
  appId: "1:121602685475:web:230ebd9c56d8eacdeecf96",
};

const app = initializeApp(firebaseConfig);

export const db = getDatabase(app);
export const auth = getAuth(app);
export default app;