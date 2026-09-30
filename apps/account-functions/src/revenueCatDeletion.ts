export const REVENUECAT_DELETION_TIMEOUT_MS = 10_000;
export type DeletionOutcome = "requested" | "absent";
export type DeletionFailureCode =
  | "invalid-uid"
  | "configuration"
  | "timeout"
  | "network"
  | "rate-limited"
  | "provider-unavailable"
  | "provider-rejected"
  | "unexpected";

const MESSAGES: Record<DeletionFailureCode, string> = {
  "invalid-uid": "Account cleanup received an invalid Firebase user identifier.",
  configuration: "Account cleanup requires a valid RevenueCat secret API key.",
  timeout: "RevenueCat account cleanup timed out; delivery remains pending.",
  network: "RevenueCat account cleanup could not connect; delivery remains pending.",
  "rate-limited": "RevenueCat account cleanup was rate limited; delivery remains pending.",
  "provider-unavailable":
    "RevenueCat account cleanup is temporarily unavailable; delivery remains pending.",
  "provider-rejected": "RevenueCat rejected account cleanup; operator attention is required.",
  unexpected: "Account cleanup could not complete; operator attention is required.",
};

/** Never retains a UID, credential, URL, response body, or original error cause. */
export class AccountCleanupError extends Error {
  constructor(
    readonly code: DeletionFailureCode,
    readonly status?: number,
  ) {
    super(MESSAGES[code]);
    this.name = "AccountCleanupError";
  }
}

export function redactCleanupError(error: unknown): AccountCleanupError {
  return error instanceof AccountCleanupError ? error : new AccountCleanupError("unexpected");
}

/**
 * Server-only, called with the UID from a completed Firebase Auth deletion event.
 * A 200 acknowledges RevenueCat's asynchronous deletion request, not final erasure.
 */
export async function deleteRevenueCatSubscriber(
  uid: string,
  secretApiKey: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DeletionOutcome> {
  let encodedUid: string;
  try {
    // Dot-only path segments normalize even when percent encoded. Never let an
    // unexpected custom UID change the fixed subscriber endpoint.
    if (typeof uid !== "string" || !uid || uid.length > 128 || uid === "." || uid === "..")
      throw new Error();
    encodedUid = encodeURIComponent(uid);
  } catch {
    throw new AccountCleanupError("invalid-uid");
  }
  const key = typeof secretApiKey === "string" ? secretApiKey.trim() : "";
  if (!key.startsWith("sk_") || key.length <= 3 || /\s/.test(key))
    throw new AccountCleanupError("configuration");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVENUECAT_DELETION_TIMEOUT_MS);
  try {
    const response = await fetcher(`https://api.revenuecat.com/v1/subscribers/${encodedUid}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
      // Credentials and identifiers must never follow a provider redirect.
      redirect: "error",
    });
    // Only HTTP status is needed; discard rather than parse or log customer data.
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 200) return "requested";
    if (response.status === 404) return "absent";
    const code =
      response.status === 429
        ? "rate-limited"
        : response.status >= 500
          ? "provider-unavailable"
          : "provider-rejected";
    throw new AccountCleanupError(code, response.status);
  } catch (error) {
    if (error instanceof AccountCleanupError) throw error;
    throw new AccountCleanupError(controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timeout);
  }
}
