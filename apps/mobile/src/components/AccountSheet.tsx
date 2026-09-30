import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  Cloud,
  CloudOff,
  LoaderCircle,
  LogOut,
  Mail,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import {
  AuthError,
  selectDeletionProvider,
  type AuthService,
  type AuthState,
} from "../services/AuthService";
import type { BackupProjectCandidate, SyncConflict, SyncState } from "../store/SyncedProjectStore";
import { ModalDialog } from "./ModalDialog";

export interface AccountBackupActions {
  listProjects(): Promise<BackupProjectCandidate[]>;
  backUp(projectIds: readonly string[]): Promise<void>;
  retrySync(): Promise<void>;
  listConflicts(): Promise<SyncConflict[]>;
  keepBoth(projectId: string): Promise<void>;
}

interface AccountSheetProps {
  auth: AuthService;
  authState: AuthState;
  syncState: SyncState | null;
  onSignOut: () => Promise<void>;
  onDeleteAccount: (password?: string) => Promise<void>;
  onClose: () => void;
  backup?: AccountBackupActions;
}

type EmailMode = "signin" | "signup" | "reset";

function errorMessage(reason: unknown): string {
  if (reason instanceof AuthError) return reason.message;
  return reason instanceof Error ? reason.message : "Something went wrong. Please try again.";
}

export function AccountSheet({
  auth,
  authState,
  syncState,
  onSignOut,
  onDeleteAccount,
  onClose,
  backup,
}: AccountSheetProps) {
  const [panelBusy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionNotice, setDeletionNotice] = useState("");
  const busy = panelBusy || deleting;
  return (
    <ModalDialog
      className="modal account-sheet"
      labelledBy="account-sheet-title"
      onClose={onClose}
      busy={busy}
    >
      <header>
        <h2 id="account-sheet-title">Account</h2>
        <button
          className="icon-button"
          disabled={busy}
          onClick={onClose}
          aria-label="Close account panel"
        >
          <X size={19} />
        </button>
      </header>
      <div className="modal-body">
        {deletionNotice && (
          <p className="auth-notice" role="status">
            {deletionNotice}
          </p>
        )}
        {authState.status === "unavailable" && (
          <p className="account-note">
            Accounts are not enabled in this build. Your projects stay saved on this device.
          </p>
        )}
        {busy && (
          <p className="account-note" role="status">
            Please wait for the current account action to finish.
          </p>
        )}
        {authState.status === "signed-out" && (
          <SignedOutPanel auth={auth} onBusyChange={setBusy} disabled={deleting} />
        )}
        {authState.status === "signed-in" && (
          <SignedInPanel
            key={authState.user.uid}
            user={authState.user}
            syncState={syncState}
            onSignOut={onSignOut}
            onDeleteAccount={async (password) => {
              setDeleting(true);
              try {
                await onDeleteAccount(password);
                setDeletionNotice(
                  "Your Firebase account and cloud backups are deleted. Cleanup of the associated purchase profile has been requested and may still be processing. Projects saved on this device are kept.",
                );
              } finally {
                setDeleting(false);
              }
            }}
            onClose={onClose}
            onBusyChange={setBusy}
            {...(backup === undefined ? {} : { backup })}
          />
        )}
      </div>
    </ModalDialog>
  );
}

function SignedOutPanel({
  auth,
  onBusyChange,
  disabled,
}: {
  auth: AuthService;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const [mode, setMode] = useState<EmailMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [working, setBusy] = useState(false);
  const busy = working || disabled;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onBusyChange(working);
  }, [working, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);
  const changeMode = (next: EmailMode) => {
    if (busyRef.current || disabled) return;
    setMode(next);
    emailRef.current?.focus();
  };

  const perform = async (operation: () => Promise<unknown>) => {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (reason) {
      if (mounted.current && !(reason instanceof AuthError && reason.code === "cancelled")) {
        setError(errorMessage(reason));
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const submitEmail = () =>
    void perform(async () => {
      const trimmed = email.trim();
      if (mode === "reset") {
        await auth.sendPasswordReset(trimmed);
        setNotice("Password reset email sent. Check your inbox.");
        setMode("signin");
        return;
      }
      if (mode === "signup") {
        await auth.signUpWithEmail(trimmed, password);
        setNotice("Account created. A verification email is on its way.");
        return;
      }
      await auth.signInWithEmail(trimmed, password);
    });

  return (
    <>
      <p className="account-note">
        Sign in to sync projects already linked to your account. Existing local projects stay on
        this device until you select them for backup. New projects created while signed in sync
        automatically to Firebase with project details and available shot images. Scene files are
        not backed up.
      </p>
      <div className="auth-providers">
        <button
          className="secondary-button full provider-button"
          disabled={busy}
          onClick={() => void perform(() => auth.signInWithApple())}
        >
          Continue with Apple
        </button>
        <button
          className="secondary-button full provider-button"
          disabled={busy}
          onClick={() => void perform(() => auth.signInWithGoogle())}
        >
          Continue with Google
        </button>
      </div>
      <div className="auth-divider">
        <span>or use email</span>
      </div>
      <label className="field-stack">
        <span className="field-label">Email</span>
        <input
          ref={emailRef}
          type="email"
          disabled={busy}
          value={email}
          autoComplete="email"
          inputMode="email"
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {mode !== "reset" && (
        <label className="field-stack">
          <span className="field-label">Password</span>
          <input
            type="password"
            disabled={busy}
            value={password}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      )}
      <button
        className="primary-button full-width"
        disabled={busy || !email.trim() || (mode !== "reset" && !password)}
        onClick={submitEmail}
      >
        {busy ? (
          <>
            <LoaderCircle className="spin" size={15} /> Working…
          </>
        ) : mode === "signup" ? (
          "Create account"
        ) : mode === "reset" ? (
          "Send reset email"
        ) : (
          "Sign in"
        )}
      </button>
      <div className="auth-links">
        {mode === "signin" && (
          <>
            <button disabled={busy} onClick={() => changeMode("signup")}>
              Create an account
            </button>
            <button disabled={busy} onClick={() => changeMode("reset")}>
              Forgot password?
            </button>
          </>
        )}
        {mode !== "signin" && (
          <button disabled={busy} onClick={() => changeMode("signin")}>
            Back to sign in
          </button>
        )}
      </div>
    </>
  );
}

function SignedInPanel({
  user,
  syncState,
  onSignOut,
  onDeleteAccount,
  onClose,
  onBusyChange,
  backup,
}: {
  user: Extract<AuthState, { status: "signed-in" }>["user"];
  syncState: SyncState | null;
  onSignOut: () => Promise<void>;
  onDeleteAccount: (password?: string) => Promise<void>;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  backup?: AccountBackupActions;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [password, setPassword] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDescriptionRef = useRef<HTMLParagraphElement>(null);
  const previousConfirmation = useRef(false);
  const needsPassword = selectDeletionProvider(user.providerIds) === "password";
  useEffect(() => {
    onBusyChange(busy || backupBusy);
  }, [busy, backupBusy, onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);
  useEffect(() => {
    if (confirmingDelete) deleteDescriptionRef.current?.focus();
    else if (previousConfirmation.current) deleteButtonRef.current?.focus();
    previousConfirmation.current = confirmingDelete;
  }, [confirmingDelete]);

  const perform = async (operation: () => Promise<void>, closeAfter: boolean) => {
    if (busyRef.current || backupBusy) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      if (closeAfter) onClose();
    } catch (reason) {
      if (mounted.current && !(reason instanceof AuthError && reason.code === "cancelled")) {
        setError(errorMessage(reason));
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <>
      <div className="account-identity">
        <span className="account-avatar">
          <Mail size={17} />
        </span>
        <span>
          <strong>{user.displayName ?? user.email ?? "Signed in"}</strong>
          <small>
            {user.email}
            {user.email !== null && (
              <>
                {" "}
                {user.emailVerified ? (
                  <em className="verified">
                    <BadgeCheck size={11} /> verified
                  </em>
                ) : (
                  <em className="unverified">unverified</em>
                )}
              </>
            )}
          </small>
        </span>
      </div>

      {syncState !== null && (
        <div className="sync-row">
          {syncState.status === "offline" ? <CloudOff size={14} /> : <Cloud size={14} />}
          <span>
            {syncState.status === "syncing" && "Syncing projects…"}
            {syncState.status === "synced" && "Projects synced"}
            {syncState.status === "offline" &&
              `Offline — ${syncState.pendingCount} change${syncState.pendingCount === 1 ? "" : "s"} waiting`}
            {syncState.status === "error" && "Sync issue — your work is safe on this device"}
            {syncState.status === "idle" && "Sync ready"}
          </span>
        </div>
      )}

      {syncState?.status === "error" && syncState.error && (
        <p className="auth-error" role="alert">
          {syncState.error}
        </p>
      )}

      {backup && <BackupPanel actions={backup} user={user} onBusyChange={setBackupBusy} />}

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      <button
        className="secondary-button full"
        disabled={busy || backupBusy}
        onClick={() => void perform(onSignOut, true)}
      >
        <LogOut size={14} /> Sign out
      </button>

      {!confirmingDelete ? (
        <button
          ref={deleteButtonRef}
          className="secondary-button full danger"
          disabled={busy || backupBusy}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 size={14} /> Delete account
        </button>
      ) : (
        <div className="delete-confirm">
          <p
            ref={deleteDescriptionRef}
            tabIndex={-1}
            id="delete-account-description"
            className="account-note danger-note"
          >
            <ShieldAlert size={13} /> This permanently deletes your Firebase account and cloud
            backups and requests cleanup of the associated purchase profile. Purchase profile
            cleanup may take additional time. Projects saved on this device are kept.
          </p>
          <p className="account-note" id="delete-purchase-description">
            Oculo Pro is a one-time purchase with no subscription to cancel. Restore purchases
            using the same store account to recover Pro access; this does not recover deleted files.
          </p>
          {needsPassword && (
            <label className="field-stack">
              <span className="field-label">Confirm password</span>
              <input
                type="password"
                disabled={busy || backupBusy}
                aria-describedby="delete-account-description"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}
          <div className="modal-actions">
            <button
              className="secondary-button"
              disabled={busy || backupBusy}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep account
            </button>
            <button
              className="secondary-button danger"
              aria-describedby="delete-account-description delete-purchase-description"
              disabled={busy || backupBusy || (needsPassword && !password)}
              onClick={() =>
                void perform(() => onDeleteAccount(needsPassword ? password : undefined), false)
              }
            >
              {busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Delete
              forever
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function BackupPanel({
  actions,
  user,
  onBusyChange,
}: {
  actions: AccountBackupActions;
  user: Extract<AuthState, { status: "signed-in" }>["user"];
  onBusyChange: (busy: boolean) => void;
}) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const mounted = useRef(false);
  const requestVersion = useRef(0);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<BackupProjectCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [listError, setListError] = useState("");
  const [conflictError, setConflictError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    const results = await Promise.allSettled([
      actionsRef.current.listProjects(),
      actionsRef.current.listConflicts(),
    ]);
    if (!mounted.current || version !== requestVersion.current) return;
    const [local, remote] = results;
    if (local.status === "fulfilled") {
      setProjects(local.value);
      setSelectedIds((ids) =>
        ids.filter((id) => local.value.some((project) => project.projectId === id)),
      );
      setListError("");
    } else {
      setListError(errorMessage(local.reason));
      setSelectedIds([]);
    }
    if (remote.status === "fulfilled") {
      setConflicts(remote.value);
      setConflictError("");
    } else {
      setConflictError(errorMessage(remote.reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
    };
  }, [refresh]);

  const perform = async (operation: () => Promise<void>, success: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    setActionError("");
    setNotice("");
    try {
      await operation();
      if (mounted.current) setNotice(success);
    } catch (reason) {
      if (mounted.current) setActionError(errorMessage(reason));
    } finally {
      if (mounted.current) {
        await refresh();
        if (mounted.current) {
          setBusy(false);
          onBusyChange(false);
        }
      }
      busyRef.current = false;
    }
  };

  return (
    <section aria-label="Project backup">
      <h3>Back up selected local projects</h3>
      <p className="account-note">
        Destination: Firebase cloud storage for{" "}
        <strong>{user.email ?? user.displayName ?? user.uid}</strong>. Choose which projects to link
        to this account. Backup includes project details and available shot images; scene files are
        not included. Large projects may sync without images, so another device may show missing
        frames.
      </p>
      <p className="account-note">
        Nothing in this list uploads until you select projects and choose Back up selected projects.
      </p>
      {loading && <p role="status">Loading backup details…</p>}
      {listError && (
        <p className="auth-error" role="alert">
          Could not read local projects: {listError}
        </p>
      )}
      {!loading && !listError && projects.length === 0 && (
        <p className="account-note">No unlinked local projects are waiting for backup.</p>
      )}
      {projects.length > 0 && (
        <fieldset disabled={busy || loading || Boolean(listError)}>
          <legend>Choose local projects to back up</legend>
          {projects.map((project) => (
            <div key={project.projectId} style={{ marginBlock: 12, overflowWrap: "anywhere" }}>
              <label>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(project.projectId)}
                  onChange={(event) =>
                    setSelectedIds((ids) =>
                      event.target.checked
                        ? [...ids, project.projectId]
                        : ids.filter((id) => id !== project.projectId),
                    )
                  }
                />{" "}
                {project.name}
              </label>
              <p className="account-note">
                {project.shotCount} shot{project.shotCount === 1 ? "" : "s"}
                {project.missingImageCount > 0 &&
                  ` · ${project.missingImageCount} image${project.missingImageCount === 1 ? "" : "s"} unavailable on this device`}
                {project.legacyOwnershipUnknown && (
                  <span>
                    {" "}
                    · Previous account unknown. Select only if you want this older project backed up
                    to the account above.
                  </span>
                )}
              </p>
            </div>
          ))}
        </fieldset>
      )}
      <button
        className="secondary-button full"
        disabled={busy || loading || Boolean(listError) || selectedIds.length === 0}
        onClick={() => {
          const ids = [...selectedIds];
          void perform(
            () => actionsRef.current.backUp(ids),
            "Selected projects are linked to this account. Check sync status for upload progress.",
          );
        }}
      >
        Back up selected projects{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
      </button>
      {conflictError && (
        <p className="auth-error" role="alert">
          Could not check cloud conflicts: {conflictError}
        </p>
      )}
      {conflicts.length > 0 && (
        <section aria-label="Project conflicts">
          <h3>Keep both versions</h3>
          <p className="account-note">
            Keep the cloud version in the original project and save your edits in a separate project
            named “local copy”. Choosing Keep both projects also backs up that copy to the account
            above. Neither existing version is overwritten in the cloud.
          </p>
          {conflicts.map((conflict) => (
            <div key={conflict.projectId}>
              <p className="account-note">
                Local: {conflict.localName}
                <br />
                Cloud: {conflict.remoteName}
              </p>
              <button
                className="secondary-button full"
                disabled={busy || loading}
                aria-label={`Keep both projects for ${conflict.localName}`}
                onClick={() =>
                  void perform(
                    () => actionsRef.current.keepBoth(conflict.projectId),
                    "Both versions are kept. Open your project library to review them.",
                  )
                }
              >
                Keep both projects
              </button>
            </div>
          ))}
        </section>
      )}
      {actionError && (
        <p className="auth-error" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      )}
      <button
        className="secondary-button full"
        disabled={busy || loading}
        onClick={() =>
          void perform(
            () => actionsRef.current.retrySync(),
            "Sync check finished. Check the status above for pending or offline changes.",
          )
        }
      >
        Retry sync
      </button>
      <button className="restore-button" disabled={busy || loading} onClick={() => void refresh()}>
        Refresh backup list
      </button>
    </section>
  );
}
