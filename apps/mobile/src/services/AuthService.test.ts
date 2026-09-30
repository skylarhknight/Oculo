import type { FirebaseApp } from "firebase/app";
import type * as FirebaseAuthModule from "firebase/auth";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  FirebaseAuthService,
  mapAuthError,
  selectDeletionProvider,
  UnavailableAuthService,
} from "./AuthService";

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as User | null },
  reauthenticateWithCredential: vi.fn(),
  reauthenticateWithPopup: vi.fn(),
  deleteUser: vi.fn(),
  signInWithGoogle: vi.fn(),
  signInWithApple: vi.fn(),
  revokeAccessToken: vi.fn(),
  nativeSignOut: vi.fn(),
}));

vi.mock("firebase/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof FirebaseAuthModule>()),
  getAuth: () => mocks.auth,
  onAuthStateChanged: () => () => undefined,
  getRedirectResult: () => Promise.resolve(null),
  reauthenticateWithCredential: mocks.reauthenticateWithCredential,
  reauthenticateWithPopup: mocks.reauthenticateWithPopup,
  deleteUser: mocks.deleteUser,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "ios" },
}));

vi.mock("@capacitor-firebase/authentication", () => ({
  FirebaseAuthentication: {
    signInWithGoogle: mocks.signInWithGoogle,
    signInWithApple: mocks.signInWithApple,
    revokeAccessToken: mocks.revokeAccessToken,
    signOut: mocks.nativeSignOut,
  },
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function account(uid = "original-account", providerId = "password"): User {
  return { uid, email: "filmmaker@example.test", providerData: [{ providerId }] } as User;
}

function authService(native = false): FirebaseAuthService {
  return new FirebaseAuthService({} as FirebaseApp, native);
}

describe("mapAuthError", () => {
  it("maps Firebase error codes to Oculo auth error codes", () => {
    expect(mapAuthError({ code: "auth/network-request-failed" }).code).toBe("network");
    expect(mapAuthError({ code: "auth/popup-closed-by-user" }).code).toBe("cancelled");
    expect(mapAuthError({ code: "auth/wrong-password" }).code).toBe("invalid-credentials");
    expect(mapAuthError({ code: "auth/invalid-credential" }).code).toBe("invalid-credentials");
    expect(mapAuthError({ code: "auth/email-already-in-use" }).code).toBe("email-in-use");
    expect(mapAuthError({ code: "auth/weak-password" }).code).toBe("weak-password");
    expect(mapAuthError({ code: "auth/requires-recent-login" }).code).toBe("requires-recent-login");
    expect(mapAuthError({ code: "auth/too-many-requests" }).code).toBe("too-many-requests");
  });

  it("detects native plugin cancellations without stable codes", () => {
    expect(mapAuthError(new Error("The user canceled the sign-in flow.")).code).toBe("cancelled");
  });

  it("falls back to unknown for unrecognized failures", () => {
    expect(mapAuthError({ code: "auth/something-new" }).code).toBe("unknown");
    expect(mapAuthError("boom").code).toBe("unknown");
  });

  it("passes AuthError instances through unchanged", () => {
    const original = new AuthError("requires-recent-login", "custom message");
    expect(mapAuthError(original)).toBe(original);
  });

  it("always produces a user-presentable message", () => {
    expect(mapAuthError({ code: "auth/wrong-password" }).message.length).toBeGreaterThan(0);
  });
});

describe("UnavailableAuthService", () => {
  it("reports unavailable state and rejects operations", async () => {
    const service = new UnavailableAuthService();
    expect(service.getState()).toEqual({ status: "unavailable" });
    await expect(service.signInWithGoogle()).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.deleteAccount()).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("selectDeletionProvider", () => {
  it("prioritizes Apple so linked Apple access is revoked", () => {
    expect(selectDeletionProvider(["password", "google.com", "apple.com"])).toBe("apple.com");
  });

  it("uses Google before password when no Apple identity is linked", () => {
    expect(selectDeletionProvider(["password", "google.com"])).toBe("google.com");
  });

  it("requires a password for email-only accounts", () => {
    expect(selectDeletionProvider(["password"])).toBe("password");
  });
});

describe("FirebaseAuthService account deletion identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.currentUser = account();
    mocks.reauthenticateWithCredential.mockResolvedValue(undefined);
    mocks.reauthenticateWithPopup.mockResolvedValue(undefined);
    mocks.deleteUser.mockResolvedValue(undefined);
    mocks.signInWithGoogle.mockResolvedValue({ credential: { idToken: "google-id-token" } });
    mocks.signInWithApple.mockResolvedValue({
      credential: { idToken: "apple-id-token", authorizationCode: "apple-revocation-code" },
    });
    mocks.revokeAccessToken.mockResolvedValue(undefined);
    mocks.nativeSignOut.mockResolvedValue(undefined);
  });

  it("deletes the confirmed User object when Firebase refreshes the same account instance", async () => {
    const confirmed = mocks.auth.currentUser;
    const beforeDelete = vi.fn(async () => {
      mocks.auth.currentUser = account();
    });

    await authService().deleteAccount({ password: "password", beforeDelete });

    expect(mocks.reauthenticateWithCredential.mock.calls[0]?.[0]).toBe(confirmed);
    expect(beforeDelete).toHaveBeenCalledOnce();
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(confirmed);
    expect(mocks.deleteUser.mock.calls[0]?.[0]).not.toBe(mocks.auth.currentUser);
  });

  it.each(["replacement", "signed-out"] as const)(
    "stops before cloud cleanup when password reauthentication completes after %s",
    async (change) => {
      const pending = deferred();
      mocks.reauthenticateWithCredential.mockReturnValueOnce(pending.promise);
      const beforeDelete = vi.fn();
      const deletion = authService().deleteAccount({ password: "password", beforeDelete });
      const rejected = expect(deletion).rejects.toMatchObject({ code: "requires-recent-login" });

      mocks.auth.currentUser = change === "replacement" ? account("other-account") : null;
      pending.resolve();

      await rejected;
      expect(beforeDelete).not.toHaveBeenCalled();
      expect(mocks.deleteUser).not.toHaveBeenCalled();
    },
  );

  it("stops after a web Google reauthentication if the signed-in account changed", async () => {
    mocks.auth.currentUser = account("original-account", "google.com");
    const pending = deferred();
    mocks.reauthenticateWithPopup.mockReturnValueOnce(pending.promise);
    const beforeDelete = vi.fn();
    const deletion = authService().deleteAccount({ beforeDelete });
    const rejected = expect(deletion).rejects.toMatchObject({ code: "requires-recent-login" });

    mocks.auth.currentUser = account("other-account");
    pending.resolve();

    await rejected;
    expect(beforeDelete).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it.each(["google.com", "apple.com"])(
    "does not reauthenticate a stale User after the native %s prompt",
    async (providerId) => {
      mocks.auth.currentUser = account("original-account", providerId);
      const pending = deferred();
      const provider = providerId === "apple.com" ? mocks.signInWithApple : mocks.signInWithGoogle;
      provider.mockImplementationOnce(async () => {
        await pending.promise;
        return { credential: { idToken: "id-token", authorizationCode: "authorization-code" } };
      });
      const beforeDelete = vi.fn();
      const deletion = authService(true).deleteAccount({ beforeDelete });
      const rejected = expect(deletion).rejects.toMatchObject({ code: "requires-recent-login" });

      mocks.auth.currentUser = account("other-account");
      pending.resolve();

      await rejected;
      expect(mocks.reauthenticateWithCredential).not.toHaveBeenCalled();
      expect(beforeDelete).not.toHaveBeenCalled();
      expect(mocks.revokeAccessToken).not.toHaveBeenCalled();
      expect(mocks.deleteUser).not.toHaveBeenCalled();
    },
  );

  it("does not revoke Apple access or delete an account that changed during cloud cleanup", async () => {
    mocks.auth.currentUser = account("original-account", "apple.com");
    const started = deferred();
    const pending = deferred();
    const deletion = authService(true).deleteAccount({
      beforeDelete: async () => {
        started.resolve();
        await pending.promise;
      },
    });
    const rejected = expect(deletion).rejects.toMatchObject({ code: "requires-recent-login" });
    await started.promise;

    mocks.auth.currentUser = account("other-account");
    pending.resolve();

    await rejected;
    expect(mocks.revokeAccessToken).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.nativeSignOut).not.toHaveBeenCalled();
  });

  it("does not delete a replacement account after Apple access revocation", async () => {
    mocks.auth.currentUser = account("original-account", "apple.com");
    const started = deferred();
    const pending = deferred();
    mocks.revokeAccessToken.mockImplementationOnce(async () => {
      started.resolve();
      await pending.promise;
    });
    const deletion = authService(true).deleteAccount();
    const rejected = expect(deletion).rejects.toMatchObject({ code: "requires-recent-login" });
    await started.promise;

    mocks.auth.currentUser = account("other-account");
    pending.resolve();

    await rejected;
    expect(mocks.revokeAccessToken).toHaveBeenCalledExactlyOnceWith({
      token: "apple-revocation-code",
    });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.nativeSignOut).not.toHaveBeenCalled();
  });

  it("preserves a cloud cleanup error and does not continue account deletion", async () => {
    const cloudFailure = new Error("Cloud cleanup could not finish.");

    await expect(
      authService().deleteAccount({
        password: "password",
        beforeDelete: () => Promise.reject(cloudFailure),
      }),
    ).rejects.toBe(cloudFailure);

    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.nativeSignOut).not.toHaveBeenCalled();
  });

  it("does not sign out a replacement native account after the original deletion finishes", async () => {
    const confirmed = mocks.auth.currentUser;
    const started = deferred();
    const pending = deferred();
    mocks.deleteUser.mockImplementationOnce(async () => {
      started.resolve();
      await pending.promise;
    });
    const deletion = authService(true).deleteAccount({ password: "password" });
    await started.promise;

    mocks.auth.currentUser = account("other-account");
    pending.resolve();

    await deletion;
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(confirmed);
    expect(mocks.nativeSignOut).not.toHaveBeenCalled();
  });

  it("signs out the native session when deletion leaves no signed-in account", async () => {
    mocks.deleteUser.mockImplementationOnce(async () => {
      mocks.auth.currentUser = null;
    });

    await authService(true).deleteAccount({ password: "password" });

    expect(mocks.nativeSignOut).toHaveBeenCalledOnce();
  });
});
