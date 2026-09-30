import type { UserRecord } from "firebase-admin/auth";
import type * as FirebaseParams from "firebase-functions/params";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RevenueCatDeletion from "../src/revenueCatDeletion.js";
import { AccountCleanupError } from "../src/revenueCatDeletion.js";
import { deleteRevenueCatCustomerAfterAuthDeletion as cleanup } from "../src/index.js";

const mocks = vi.hoisted(() => ({
  secret: vi.fn(() => "sk_fixture_only_not_a_real_key"),
  deletion: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("firebase-functions/logger", () => ({ info: mocks.info, error: mocks.error }));
vi.mock("firebase-functions/params", async (importOriginal) => {
  const actual = await importOriginal<typeof FirebaseParams>();
  return {
    ...actual,
    defineSecret: (name: string) => {
      const secret = actual.defineSecret(name);
      vi.spyOn(secret, "value").mockImplementation(mocks.secret);
      return secret;
    },
  };
});
vi.mock("../src/revenueCatDeletion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RevenueCatDeletion>()),
  deleteRevenueCatSubscriber: mocks.deletion,
}));

const deletedUser = { uid: "private-user-id", email: "personal@example.invalid" } as UserRecord;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.secret.mockReturnValue("sk_fixture_only_not_a_real_key");
  mocks.deletion.mockResolvedValue("requested");
});

describe("completed Firebase Auth deletion trigger", () => {
  it("registers only an Auth user deletion event, with bound secret and retries", () => {
    vi.stubEnv("GCLOUD_PROJECT", "demo-oculo");
    try {
      expect(cleanup.__trigger).toMatchObject({
        eventTrigger: { eventType: "providers/firebase.auth/eventTypes/user.delete" },
        failurePolicy: { retry: {} },
        timeout: "30s",
      });
      expect(cleanup.__endpoint).toMatchObject({
        platform: "gcfv1",
        secretEnvironmentVariables: [{ key: "REVENUECAT_SECRET_API_KEY" }],
        eventTrigger: { retry: true },
      });
      expect(cleanup.__trigger).not.toHaveProperty("httpsTrigger");
      expect(mocks.secret).not.toHaveBeenCalled();
      expect(mocks.deletion).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["requested", "absent"])(
    "acknowledges %s without logging customer data",
    async (outcome) => {
      mocks.deletion.mockResolvedValue(outcome);
      await cleanup.run(deletedUser, {});
      expect(mocks.deletion).toHaveBeenCalledExactlyOnceWith(
        deletedUser.uid,
        "sk_fixture_only_not_a_real_key",
      );
      expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
        "RevenueCat account cleanup acknowledged",
        { outcome },
      );
      expect(mocks.error).not.toHaveBeenCalled();
      expect(JSON.stringify(mocks.info.mock.calls)).not.toMatch(
        /private-user-id|personal@|sk_fixture/,
      );
    },
  );

  it("fails delivery with status-only diagnostics so a temporary failure can retry", async () => {
    mocks.deletion.mockRejectedValue(new AccountCleanupError("rate-limited", 429));
    await expect(cleanup.run(deletedUser, {})).rejects.toMatchObject({
      code: "rate-limited",
      status: 429,
    });
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("RevenueCat account cleanup pending", {
      code: "rate-limited",
      status: 429,
    });
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("redacts unexpected secret-access and SDK errors before logs and rejection", async () => {
    mocks.secret.mockImplementation(() => {
      throw new Error("private-user-id personal@example.invalid sk_fixture_only_not_a_real_key");
    });
    const failure = await Promise.resolve(cleanup.run(deletedUser, {})).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "unexpected" });
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toMatch(/private-user-id|personal@|sk_fixture/);
    expect(JSON.stringify(mocks.error.mock.calls)).not.toMatch(
      /private-user-id|personal@|sk_fixture/,
    );
    expect(mocks.deletion).not.toHaveBeenCalled();
  });
});
