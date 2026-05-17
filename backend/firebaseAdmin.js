import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const projectId = 'almetales-eadf3';

function credential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  const credentialPath = resolveCredentialPath();
  if (credentialPath) {
    return admin.credential.cert(JSON.parse(fs.readFileSync(credentialPath, 'utf8')));
  }

  return admin.credential.applicationDefault();
}

function resolveCredentialPath() {
  const configuredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;

  const localCredential = fs
    .readdirSync(process.cwd())
    .find((file) => file.includes('firebase-adminsdk') && file.endsWith('.json'));

  return localCredential ? path.join(process.cwd(), localCredential) : '';
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: credential(),
    projectId
  });
}

export const firestore = admin.firestore();
