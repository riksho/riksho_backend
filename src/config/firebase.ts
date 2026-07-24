import admin from "firebase-admin";
import { logger } from "../common/logger.js";

/**
 * Firebase Admin SDK — initialised from env-encoded service account.
 * The JSON credentials are stored in FIREBASE_SERVICE_ACCOUNT env var.
 */

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!raw) {
  logger.warn("FIREBASE_SERVICE_ACCOUNT not set — FCM push will be unavailable");
}

let firebaseApp: admin.app.App | null = null;

if (raw) {
  try {
    const serviceAccount = JSON.parse(raw);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    logger.info("✅ Firebase Admin SDK initialised");
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to initialise Firebase Admin SDK");
  }
}

/**
 * Returns the Firebase Messaging instance.
 * Returns null if Firebase is not configured.
 */
export function getMessaging(): admin.messaging.Messaging | null {
  if (!firebaseApp) return null;
  return admin.messaging();
}

export { firebaseApp };
