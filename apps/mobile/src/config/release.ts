/** Public links are supplied by the publisher; never invent a policy or support destination. */
function httpsLink(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export const RELEASE_LINKS = Object.freeze({
  privacy: httpsLink(import.meta.env.VITE_PRIVACY_POLICY_URL),
  support: httpsLink(import.meta.env.VITE_SUPPORT_URL),
  terms: httpsLink(import.meta.env.VITE_TERMS_URL),
});

export const PURCHASE_DISCLOSURES_READY = Boolean(RELEASE_LINKS.privacy && RELEASE_LINKS.terms);
