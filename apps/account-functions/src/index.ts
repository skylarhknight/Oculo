import { error as logError, info } from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { runWith } from "firebase-functions/v1";
import { deleteRevenueCatSubscriber, redactCleanupError } from "./revenueCatDeletion.js";

const revenueCatSecret = defineSecret("REVENUECAT_SECRET_API_KEY");

// Auth lifecycle deletion events require first-generation Firebase Functions.
// This is an event trigger, never a client-callable arbitrary-UID deletion API.
export const deleteRevenueCatCustomerAfterAuthDeletion = runWith({
  secrets: [revenueCatSecret],
  failurePolicy: true,
  timeoutSeconds: 30,
  memory: "128MB",
  maxInstances: 5,
})
  .auth.user()
  .onDelete(async (user) => {
    try {
      const outcome = await deleteRevenueCatSubscriber(user.uid, revenueCatSecret.value());
      info("RevenueCat account cleanup acknowledged", { outcome });
    } catch (error) {
      const failure = redactCleanupError(error);
      logError("RevenueCat account cleanup pending", {
        code: failure.code,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      });
      // Keeping failures unacknowledged lets the platform redeliver transient
      // failures and configuration failures corrected within its retry window.
      throw failure;
    }
  });
