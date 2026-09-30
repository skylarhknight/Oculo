// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountSheet, type AccountBackupActions } from "./AccountSheet";
import { UnavailableAuthService } from "../services/AuthService";
import type { BackupProjectCandidate } from "../store/SyncedProjectStore";

const local: BackupProjectCandidate = {
  projectId: "local",
  name: "Café commercial",
  shotCount: 3,
  missingImageCount: 1,
  legacyOwnershipUnknown: false,
};
const legacy: BackupProjectCandidate = {
  projectId: "legacy",
  name: "Older scout",
  shotCount: 2,
  missingImageCount: 0,
  legacyOwnershipUnknown: true,
};

function actions(projects = [local, legacy]): AccountBackupActions {
  return {
    listProjects: vi.fn().mockResolvedValue(projects),
    backUp: vi.fn().mockResolvedValue(undefined),
    retrySync: vi.fn().mockResolvedValue(undefined),
    listConflicts: vi.fn().mockResolvedValue([]),
    keepBoth: vi.fn().mockResolvedValue(undefined),
  };
}
function props(backup: AccountBackupActions, uid = "first"): ComponentProps<typeof AccountSheet> {
  return {
    auth: new UnavailableAuthService(),
    authState: {
      status: "signed-in",
      user: {
        uid,
        email: `${uid}@example.com`,
        displayName: uid,
        emailVerified: true,
        providerIds: ["password"],
      },
    },
    syncState: { status: "synced", pendingCount: 0 },
    onSignOut: vi.fn().mockResolvedValue(undefined),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    backup,
  };
}
function button(name: RegExp | string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(cleanup);

describe("AccountSheet backup consent", () => {
  it("focuses the deletion warning, describes the purchase restoration, and restores the Keep account target", async () => {
    const user = userEvent.setup();
    render(createElement(AccountSheet, props(actions([]))));
    await user.click(button("Delete account"));
    const warning = screen.getByText(/This permanently deletes your Firebase account/);
    expect(document.activeElement).toBe(warning);
    expect(button("Delete forever").getAttribute("aria-describedby")).toContain(warning.id);
    expect(screen.getByText(/one-time purchase with no subscription/)).toBeDefined();
    await user.click(button("Keep account"));
    expect(document.activeElement).toBe(button("Delete account"));
  });

  it("keeps email sign-in named and blocks dismissal and mode changes until the operation settles", async () => {
    const pending = deferred<never>();
    const input = props(actions([]));
    input.authState = { status: "signed-out" };
    const signIn = vi.spyOn(input.auth, "signInWithEmail").mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(createElement(AccountSheet, input));
    await user.click(button("Forgot password?"));
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
    await user.click(button("Back to sign in"));
    await user.type(screen.getByLabelText("Email"), "filmmaker@example.com");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(button("Sign in"));
    expect(button("Working…").disabled).toBe(true);
    expect(button("Create an account").disabled).toBe(true);
    expect(button("Close account panel").disabled).toBe(true);
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(input.onClose).not.toHaveBeenCalled();
    expect(signIn).toHaveBeenCalledTimes(1);
    // The provider boundary resolving must restore close controls even if auth
    // has not yet emitted a replacement account state.
    await act(async () => pending.resolve(undefined as never));
    expect(button("Close account panel").disabled).toBe(false);
    await user.keyboard("{Escape}");
    expect(input.onClose).toHaveBeenCalledTimes(1);
  });

  it("uploads nothing until explicit selection and backup, with destination and legacy disclosure", async () => {
    const backup = actions();
    const user = userEvent.setup();
    render(createElement(AccountSheet, props(backup)));
    const checkbox = (await screen.findByLabelText("Older scout")) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(button(/Back up selected projects/).disabled).toBe(true);
    expect(screen.getByText(/Destination: Firebase cloud storage/).textContent).toContain(
      "first@example.com",
    );
    expect(screen.getByText(/Previous account unknown/)).toBeDefined();
    expect(screen.getByText(/1 image unavailable/)).toBeDefined();
    expect(backup.backUp).not.toHaveBeenCalled();
    await user.click(checkbox);
    expect(backup.backUp).not.toHaveBeenCalled();
    await user.click(button(/Back up selected projects/));
    await waitFor(() => expect(backup.backUp).toHaveBeenCalledWith(["legacy"]));
    await screen.findByText(/Selected projects are linked to this account/);
  });

  it("keeps backup disabled when local project listing fails, and supports a read-only retry", async () => {
    const backup = actions();
    vi.mocked(backup.listProjects).mockRejectedValueOnce(new Error("Device storage is locked"));
    const user = userEvent.setup();
    render(createElement(AccountSheet, props(backup)));
    await screen.findByText(/Could not read local projects: Device storage is locked/);
    expect(button(/Back up selected projects/).disabled).toBe(true);
    await user.click(button("Refresh backup list"));
    await screen.findByLabelText("Café commercial");
    expect(backup.backUp).not.toHaveBeenCalled();
  });

  it("shows backup failure without a success claim and lets the selected action be retried", async () => {
    const backup = actions();
    vi.mocked(backup.backUp).mockRejectedValueOnce(new Error("Backup could not reach Firebase"));
    const user = userEvent.setup();
    render(createElement(AccountSheet, props(backup)));
    await user.click(await screen.findByLabelText("Café commercial"));
    await user.click(button(/Back up selected projects/));
    await screen.findByText("Backup could not reach Firebase");
    expect(screen.queryByText(/Selected projects are linked/)).toBeNull();
    await waitFor(() => expect(button(/Back up selected projects/).disabled).toBe(false));
    await user.click(button(/Back up selected projects/));
    await screen.findByText(/Selected projects are linked/);
    expect(backup.backUp).toHaveBeenCalledTimes(2);
  });

  it("shows the actual sync error and never hides a failed retry behind a completion message", async () => {
    const backup = actions([]);
    vi.mocked(backup.retrySync).mockRejectedValueOnce(new Error("Cloud request failed"));
    const input = props(backup);
    input.syncState = {
      status: "error",
      pendingCount: 1,
      error: "A newer cloud version conflicts with local edits",
    };
    const user = userEvent.setup();
    render(createElement(AccountSheet, input));
    await screen.findByText("No unlinked local projects are waiting for backup.");
    expect(screen.getByText("A newer cloud version conflicts with local edits")).toBeDefined();
    await user.click(button("Retry sync"));
    await screen.findByText("Cloud request failed");
    expect(screen.queryByText(/Sync check finished/)).toBeNull();
    await waitFor(() => expect(button("Retry sync").disabled).toBe(false));
    await user.click(button("Retry sync"));
    await screen.findByText(/Sync check finished/);
  });

  it("keeps conflict recovery read-only until the user chooses the disclosed keep-both action", async () => {
    const backup = actions([]);
    vi.mocked(backup.listConflicts).mockResolvedValue([
      { projectId: "conflict", localName: "Local take", remoteName: "Client revision" },
    ]);
    const user = userEvent.setup();
    render(createElement(AccountSheet, props(backup)));
    await screen.findByRole("button", { name: "Keep both projects for Local take" });
    expect(screen.getByText(/Choosing Keep both projects also backs up that copy/)).toBeDefined();
    expect(backup.keepBoth).not.toHaveBeenCalled();
    await user.click(button("Keep both projects for Local take"));
    await waitFor(() => expect(backup.keepBoth).toHaveBeenCalledWith("conflict"));
  });

  it("clears selections and consent when the account changes", async () => {
    const first = actions([local]);
    const second = actions([{ ...legacy, name: "Second project" }]);
    const user = userEvent.setup();
    const view = render(createElement(AccountSheet, props(first)));
    await user.click(await screen.findByLabelText("Café commercial"));
    expect(button(/Back up selected projects/).disabled).toBe(false);
    view.rerender(createElement(AccountSheet, props(second, "second")));
    const nextCheckbox = (await screen.findByLabelText("Second project")) as HTMLInputElement;
    expect(nextCheckbox.checked).toBe(false);
    expect(screen.queryByLabelText("Café commercial")).toBeNull();
    expect(button(/Back up selected projects/).disabled).toBe(true);
    await user.click(nextCheckbox);
    await user.click(button(/Back up selected projects/));
    await waitFor(() => expect(second.backUp).toHaveBeenCalledWith(["legacy"]));
    expect(first.backUp).not.toHaveBeenCalled();
  });

  it("ignores a previous account's delayed list response", async () => {
    const oldResponse = deferred<BackupProjectCandidate[]>();
    const first = actions();
    vi.mocked(first.listProjects).mockReturnValue(oldResponse.promise);
    const second = actions([{ ...legacy, name: "Second project" }]);
    const view = render(createElement(AccountSheet, props(first)));
    view.rerender(createElement(AccountSheet, props(second, "second")));
    await screen.findByLabelText("Second project");
    oldResponse.resolve([local]);
    await waitFor(() => expect(screen.queryByLabelText("Café commercial")).toBeNull());
    expect(first.backUp).not.toHaveBeenCalled();
  });

  it("prevents concurrent backup and sign-out actions while a consented request is pending", async () => {
    const pending = deferred<void>();
    const backup = actions([local]);
    vi.mocked(backup.backUp).mockReturnValue(pending.promise);
    const user = userEvent.setup();
    const input = props(backup);
    render(createElement(AccountSheet, input));
    await user.click(await screen.findByLabelText("Café commercial"));
    await user.click(button(/Back up selected projects/));
    expect(button(/Back up selected projects/).disabled).toBe(true);
    expect(button(/Sign out/).disabled).toBe(true);
    expect(button("Close account panel").disabled).toBe(true);
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(input.onClose).not.toHaveBeenCalled();
    await user.click(button(/Back up selected projects/));
    expect(backup.backUp).toHaveBeenCalledTimes(1);
    pending.resolve();
    await waitFor(() => expect(button(/Sign out/).disabled).toBe(false));
    await user.keyboard("{Escape}");
    expect(input.onClose).toHaveBeenCalledTimes(1);
  });
});
