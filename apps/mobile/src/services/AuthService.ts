import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import type { FirebaseApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  revokeAccessToken as revokeFirebaseAccessToken,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
} from "firebase/auth";
import type { Auth, AuthCredential, User } from "firebase/auth";
import { getFirebaseApp } from "./firebase";

/**
 * Oculo-owned auth contracts. Firebase SDK types never leave this module.
 */

export type AuthErrorCode =
  | "network"
  | "cancelled"
  | "invalid-credentials"
  | "email-in-use"
  | "weak-password"
  | "requires-recent-login"
  | "too-many-requests"
  | "unavailable"
  | "unknown";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  providerIds: string[];
}

export type AuthState =
  { status: "unavailable" } | { status: "signed-out" } | { status: "signed-in"; user: AuthUser };

export type DeletionProvider = "apple.com" | "google.com" | "password";

export interface DeleteAccountOptions {
  password?: string;
  /**
   * Runs after successful reauthentication but before provider revocation and
   * Firebase user deletion. Cloud project cleanup belongs here because it
   * still requires the user's valid Firebase session.
   */
  beforeDelete?: () => Promise<void>;
}

export function selectDeletionProvider(providerIds: readonly string[]): DeletionProvider {
  if (providerIds.includes("apple.com")) return "apple.com";
  if (providerIds.includes("google.com")) return "google.com";
  return "password";
}

export interface AuthService {
  getState(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  signInWithGoogle(): Promise<AuthUser>;
  signInWithApple(): Promise<AuthUser>;
  signUpWithEmail(email: string, password: string): Promise<AuthUser>;
  signInWithEmail(email: string, password: string): Promise<AuthUser>;
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Deletes the Firebase account. When the session is too old, Firebase
   * requires reauthentication: email accounts need `password`, while Google
   * and Apple accounts trigger a fresh provider sign-in flow.
   */
  deleteAccount(options?: DeleteAccountOptions): Promise<void>;
}

const FIREBASE_CODE_MAP: Record<string, AuthErrorCode> = {
  "auth/network-request-failed": "network",
  "auth/timeout": "network",
  "auth/popup-closed-by-user": "cancelled",
  "auth/cancelled-popup-request": "cancelled",
  "auth/user-cancelled": "cancelled",
  "auth/popup-blocked": "cancelled",
  "auth/invalid-credential": "invalid-credentials",
  "auth/invalid-email": "invalid-credentials",
  "auth/user-not-found": "invalid-credentials",
  "auth/wrong-password": "invalid-credentials",
  "auth/invalid-login-credentials": "invalid-credentials",
  "auth/user-disabled": "invalid-credentials",
  "auth/missing-password": "invalid-credentials",
  "auth/email-already-in-use": "email-in-use",
  "auth/weak-password": "weak-password",
  "auth/password-does-not-meet-requirements": "weak-password",
  "auth/requires-recent-login": "requires-recent-login",
  "auth/too-many-requests": "too-many-requests",
};

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  network: "Could not reach the sign-in service. Check your connection and try again.",
  cancelled: "Sign-in was cancelled.",
  "invalid-credentials": "The email or password is incorrect.",
  "email-in-use": "An account with this email already exists. Try signing in instead.",
  "weak-password": "Choose a stronger password (at least 6 characters).",
  "requires-recent-login": "Please confirm your credentials to continue.",
  "too-many-requests": "Too many attempts. Wait a moment and try again.",
  unavailable: "Accounts are not available in this build.",
  unknown: "Sign-in failed. Please try again.",
};

/** Maps a Firebase or native-plugin failure to an Oculo AuthError. */
export function mapAuthError(reason: unknown): AuthError {
  if (reason instanceof AuthError) return reason;
  let code: AuthErrorCode = "unknown";
  const raw =
    typeof reason === "object" && reason !== null && "code" in reason
      ? String((reason as { code: unknown }).code)
      : "";
  const mapped = FIREBASE_CODE_MAP[raw];
  if (mapped !== undefined) {
    code = mapped;
  } else if (reason instanceof Error && /cancel/i.test(reason.message)) {
    // Native plugin cancellations surface as plain errors without stable codes.
    code = "cancelled";
  } else if (reason instanceof Error && /network/i.test(reason.message)) {
    code = "network";
  }
  return new AuthError(code, AUTH_ERROR_MESSAGES[code]);
}

function toAuthUser(user: User): AuthUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    providerIds: user.providerData.map((provider) => provider.providerId),
  };
}

/** Used when Firebase is not configured; the app stays fully local. */
export class UnavailableAuthService implements AuthService {
  getState(): AuthState {
    return { status: "unavailable" };
  }

  subscribe(): () => void {
    return () => undefined;
  }

  private fail(): Promise<never> {
    return Promise.reject(new AuthError("unavailable", AUTH_ERROR_MESSAGES.unavailable));
  }

  signInWithGoogle(): Promise<AuthUser> {
    return this.fail();
  }
  signInWithApple(): Promise<AuthUser> {
    return this.fail();
  }
  signUpWithEmail(): Promise<AuthUser> {
    return this.fail();
  }
  signInWithEmail(): Promise<AuthUser> {
    return this.fail();
  }
  sendPasswordReset(): Promise<void> {
    return this.fail();
  }
  signOut(): Promise<void> {
    return this.fail();
  }
  deleteAccount(): Promise<void> {
    return this.fail();
  }
}

export class FirebaseAuthService implements AuthService {
  private readonly auth: Auth;
  private state: AuthState = { status: "signed-out" };
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(
    app: FirebaseApp,
    private readonly native: boolean,
  ) {
    this.auth = getAuth(app);
    onAuthStateChanged(this.auth, (user) => {
      this.state =
        user === null ? { status: "signed-out" } : { status: "signed-in", user: toAuthUser(user) };
      for (const listener of this.listeners) listener(this.state);
    });
    if (!this.native) {
      // Completes a pending redirect-based sign-in after the page reloads.
      void getRedirectResult(this.auth).catch(() => undefined);
    }
  }

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async signInWithGoogle(): Promise<AuthUser> {
    try {
      if (this.native) {
        const result = await FirebaseAuthentication.signInWithGoogle();
        const idToken = result.credential?.idToken;
        if (!idToken) throw new AuthError("unknown", AUTH_ERROR_MESSAGES.unknown);
        const credential = GoogleAuthProvider.credential(
          idToken,
          result.credential?.accessToken ?? null,
        );
        return toAuthUser((await signInWithCredential(this.auth, credential)).user);
      }
      return toAuthUser(await this.webProviderSignIn(new GoogleAuthProvider()));
    } catch (reason) {
      throw mapAuthError(reason);
    }
  }

  async signInWithApple(): Promise<AuthUser> {
    try {
      if (this.native) {
        // Apple credentials are single-use: skip native-layer auth so the
        // credential can be consumed by the Firebase JS SDK.
        const result = await FirebaseAuthentication.signInWithApple({ skipNativeAuth: true });
        const credential = this.appleCredentialFrom(result.credential ?? null);
        return toAuthUser((await signInWithCredential(this.auth, credential)).user);
      }
      return toAuthUser(await this.webProviderSignIn(new OAuthProvider("apple.com")));
    } catch (reason) {
      throw mapAuthError(reason);
    }
  }

  async signUpWithEmail(email: string, password: string): Promise<AuthUser> {
    try {
      const result = await createUserWithEmailAndPassword(this.auth, email, password);
      await sendEmailVerification(result.user).catch(() => undefined);
      return toAuthUser(result.user);
    } catch (reason) {
      throw mapAuthError(reason);
    }
  }

  async signInWithEmail(email: string, password: string): Promise<AuthUser> {
    try {
      const result = await signInWithEmailAndPassword(this.auth, email, password);
      return toAuthUser(result.user);
    } catch (reason) {
      throw mapAuthError(reason);
    }
  }

  async sendPasswordReset(email: string): Promise<void> {
    try {
      await sendPasswordResetEmail(this.auth, email);
    } catch (reason) {
      throw mapAuthError(reason);
    }
  }

  async signOut(): Promise<void> {
    try {
      await firebaseSignOut(this.auth);
    } catch (reason) {
      throw mapAuthError(reason);
    }
    if (this.native) {
      await FirebaseAuthentication.signOut().catch(() => undefined);
    }
  }

  async deleteAccount(options: DeleteAccountOptions = {}): Promise<void> {
    const user = this.auth.currentUser;
    if (user === null) throw new AuthError("unavailable", "No account is signed in.");
    const uid = user.uid;
    const assertSameAccount = (): void => {
      if (this.auth.currentUser?.uid !== uid) {
        throw new AuthError(
          "requires-recent-login",
          "The signed-in account changed. Review the account before trying deletion again.",
        );
      }
    };

    let revokeProviderAccess: (() => Promise<void>) | undefined;
    try {
      revokeProviderAccess = await this.authorizeAccountDeletion(
        user,
        options.password,
        assertSameAccount,
      );
      assertSameAccount();
    } catch (reason) {
      throw mapAuthError(reason);
    }

    // Cloud data must be deleted while the authenticated session still exists.
    // Keep these errors intact so the UI can report a sync failure accurately.
    await options.beforeDelete?.();

    try {
      assertSameAccount();
      await revokeProviderAccess?.();
      assertSameAccount();
      // Always delete the user whose identity was confirmed, even if Firebase
      // refreshed its current User instance while cleanup was in progress.
      await deleteUser(user);
    } catch (reason) {
      throw mapAuthError(reason);
    }

    if (this.native && (this.auth.currentUser === null || this.auth.currentUser.uid === uid)) {
      await FirebaseAuthentication.signOut().catch(() => undefined);
    }
  }

  private async webProviderSignIn(provider: GoogleAuthProvider | OAuthProvider): Promise<User> {
    try {
      return (await signInWithPopup(this.auth, provider)).user;
    } catch (reason) {
      const raw =
        typeof reason === "object" && reason !== null && "code" in reason
          ? String((reason as { code: unknown }).code)
          : "";
      if (raw === "auth/popup-blocked") {
        // Redirect flow completes via getRedirectResult after page reload.
        await signInWithRedirect(this.auth, provider);
      }
      throw reason;
    }
  }

  private appleCredentialFrom(
    credential: { idToken?: string; nonce?: string } | null,
  ): AuthCredential {
    const idToken = credential?.idToken;
    if (!idToken) throw new AuthError("unknown", AUTH_ERROR_MESSAGES.unknown);
    const nonce = credential?.nonce;
    return new OAuthProvider("apple.com").credential({
      idToken,
      ...(nonce ? { rawNonce: nonce } : {}),
    });
  }

  private async authorizeAccountDeletion(
    user: User,
    password: string | undefined,
    assertSameAccount: () => void,
  ): Promise<(() => Promise<void>) | undefined> {
    const providerId = selectDeletionProvider(
      user.providerData.map((provider) => provider.providerId),
    );
    try {
      if (providerId === "password") {
        if (!user.email || !password) {
          throw new AuthError(
            "requires-recent-login",
            "Enter your password to confirm account deletion.",
          );
        }
        await reauthenticateWithCredential(
          user,
          EmailAuthProvider.credential(user.email, password),
        );
        return undefined;
      }
      if (providerId === "google.com") {
        if (this.native) {
          const result = await FirebaseAuthentication.signInWithGoogle();
          assertSameAccount();
          const idToken = result.credential?.idToken;
          if (!idToken) throw new AuthError("unknown", AUTH_ERROR_MESSAGES.unknown);
          await reauthenticateWithCredential(
            user,
            GoogleAuthProvider.credential(idToken, result.credential?.accessToken ?? null),
          );
        } else {
          await reauthenticateWithPopup(user, new GoogleAuthProvider());
        }
        return undefined;
      }

      if (this.native) {
        const result = await FirebaseAuthentication.signInWithApple({ skipNativeAuth: true });
        assertSameAccount();
        await reauthenticateWithCredential(
          user,
          this.appleCredentialFrom(result.credential ?? null),
        );
        assertSameAccount();
        const revocationToken =
          Capacitor.getPlatform() === "ios"
            ? result.credential?.authorizationCode
            : result.credential?.accessToken;
        if (!revocationToken) {
          throw new AuthError("unknown", "Apple did not provide a token for access revocation.");
        }
        // On iOS the plugin passes an authorization code to
        // Auth.revokeToken(withAuthorizationCode:); Android uses the Apple
        // OAuth access token with FirebaseAuth.revokeAccessToken().
        return () => FirebaseAuthentication.revokeAccessToken({ token: revocationToken });
      }

      const result = await reauthenticateWithPopup(user, new OAuthProvider("apple.com"));
      assertSameAccount();
      const accessToken = OAuthProvider.credentialFromResult(result)?.accessToken;
      if (!accessToken) {
        throw new AuthError("unknown", "Apple did not provide an access token.");
      }
      return () => revokeFirebaseAccessToken(this.auth, accessToken);
    } catch (reason) {
      throw mapAuthError(reason);
    }
  }
}

export function createAuthService(): AuthService {
  const app = getFirebaseApp();
  if (app === null) return new UnavailableAuthService();
  if (Capacitor.isNativePlatform() && !Capacitor.isPluginAvailable("FirebaseAuthentication")) {
    return new UnavailableAuthService();
  }
  return new FirebaseAuthService(app, Capacitor.isNativePlatform());
}
