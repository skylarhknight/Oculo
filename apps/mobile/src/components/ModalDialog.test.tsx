// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModalDialog } from "./ModalDialog";

afterEach(cleanup);

function Example({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return (
    <main>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <button>Background action</button>
      {open && (
        <ModalDialog
          labelledBy="settings-title"
          describedBy="settings-description"
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <h2 id="settings-title">Settings</h2>
          <p id="settings-description">Change the current project’s guides.</p>
          <button disabled={busy} onClick={() => setOpen(false)}>
            Close settings
          </button>
          <button disabled>Unavailable option</button>
          <input aria-label="Hidden field" hidden />
          <button disabled={busy} onClick={() => setNested(true)}>
            More settings
          </button>
          {nested && (
            <ModalDialog labelledBy="more-title" onClose={() => setNested(false)}>
              <h2 id="more-title">More settings</h2>
              <button onClick={() => setNested(false)}>Close more settings</button>
            </ModalDialog>
          )}
        </ModalDialog>
      )}
    </main>
  );
}

describe("ModalDialog keyboard and background access", () => {
  it("announces the dialog, contains keyboard focus, excludes the background, then returns focus", async () => {
    const user = userEvent.setup();
    const view = render(<Example />);
    const opener = screen.getByRole("button", { name: "Open settings" });
    const background = screen.getByRole("button", { name: "Background action" });
    opener.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", {
      name: "Settings",
      description: /project’s guides/,
    });
    expect(document.activeElement).toBe(dialog);
    expect(view.container.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("button", { name: "Background action" })).toBeNull();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More settings" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close settings" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More settings" }));
    background.focus();
    expect(document.activeElement).toBe(dialog);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(view.container.hasAttribute("inert")).toBe(false);
    expect(view.container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("guards Escape and backdrop dismissal while busy, including when no controls are enabled", async () => {
    const user = userEvent.setup();
    const view = render(<Example busy />);
    const opener = screen.getByRole("button", { name: "Open settings" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    await user.tab();
    expect(document.activeElement).toBe(dialog);
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByRole("dialog")).toBe(dialog);
    view.rerender(<Example />);
    await user.click(dialog.parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the app excluded while a nested dialog closes and restores existing attributes", async () => {
    const user = userEvent.setup();
    const view = render(<Example />);
    view.container.setAttribute("aria-hidden", "false");
    const opener = screen.getByRole("button", { name: "Open settings" });
    await user.click(opener);
    const outer = screen.getByRole("dialog", { name: "Settings" });
    const nestedOpener = screen.getByRole("button", { name: "More settings" });
    await user.click(nestedOpener);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "More settings" }));
    expect(outer.parentElement?.hasAttribute("inert")).toBe(true);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(nestedOpener);
    expect(view.container.hasAttribute("inert")).toBe(true);
    expect(screen.getAllByRole("dialog")).toEqual([outer]);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
    expect(view.container.hasAttribute("inert")).toBe(false);
    expect(view.container.getAttribute("aria-hidden")).toBe("false");
  });
});
