import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  BadgeCheck,
  ChevronRight,
  GraduationCap,
  HardDrive,
  Moon,
  SunMedium,
  Smartphone,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import { SENSOR_PRESETS } from "@oculo/camera-core";
import { useAppServices } from "../app/AppServices";
import { AccountSheet } from "../components/AccountSheet";
import { ReleaseLinks } from "../components/ReleaseLinks";
import { SCENE_GALLERY } from "../config/sceneCatalog";
import { useNavigation } from "../navigation/Navigation";
import { createTutorialProject } from "../services/tutorial";
import { aspectLabel } from "../services/cameraState";
import { plural, RangeControl, Segmented, Toggle } from "../ui/controls";
import { ConfirmSheet } from "../ui/Sheet";
import { useReveal } from "../ui/useReveal";
import { useScrollEdge } from "../ui/useScrollEdge";
import "./screens.css";

export const ASPECT_OPTIONS = [16 / 9, 2.39, 4 / 3, 1, 9 / 16] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SettingsScreen() {
  const services = useAppServices();
  const { preferences, updatePreferences, presets, projects, purchase, authState } = services;
  const navigation = useNavigation();
  const scrollEdge = useScrollEdge();
  const sectionsRef = useRef<HTMLDivElement>(null);
  useReveal(sectionsRef, ":scope > .settings-section");
  const [accountOpen, setAccountOpen] = useState(false);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [message, setMessage] = useState("");
  const [downloads, setDownloads] = useState<{ versionId: string; byteSize: number }[]>([]);
  const [removing, setRemoving] = useState<{ versionId: string; title: string } | null>(null);

  useEffect(() => {
    let active = true;
    void navigator.storage
      ?.estimate?.()
      .then((estimate) => {
        if (active && estimate.usage !== undefined && estimate.quota !== undefined)
          setUsage({ usage: estimate.usage, quota: estimate.quota });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projects]);

  useEffect(() => {
    let active = true;
    void services.local
      .listGalleryAssets()
      .then((rows) => {
        if (active) setDownloads(rows);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [services.local]);

  const removeDownload = async (versionId: string) => {
    await services.local.deleteGalleryAsset(versionId);
    setDownloads((current) => current.filter((row) => row.versionId !== versionId));
    setRemoving(null);
  };

  const camera = preferences.camera;
  const sensor =
    Object.values(SENSOR_PRESETS).find(
      (preset) =>
        preset.widthMm === camera.sensorWidthMm && preset.heightMm === camera.sensorHeightMm,
    )?.id ?? "custom";
  const tutorial = projects.find((project) => project.tutorial);
  const signedIn = authState.status === "signed-in";

  const resetTutorial = async () => {
    setMessage("");
    try {
      if (tutorial) await services.store.delete(tutorial.id);
      await services.store.put(createTutorialProject());
      await updatePreferences({ tutorialSeeded: true });
      await services.refreshLibrary();
      setMessage(tutorial ? "Tutorial reset." : "Tutorial added to your projects.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "The tutorial could not be reset.");
    }
  };

  return (
    <div className="screen settings-screen">
      <header className="app-bar">
        <button className="icon-btn" aria-label="Back" onClick={() => void navigation.pop()}>
          <ChevronLeft size={28} strokeWidth={2.2} />
        </button>
        <span className="app-bar__title">Settings</span>
        <span className="app-bar__spacer" />
      </header>
      <div className="screen-scroll">
        <div className="scroll-edge" ref={scrollEdge} aria-hidden="true" />
        <div ref={sectionsRef}>
          <h1 className="large-title">Settings</h1>
          <SettingsSection title="Appearance" note="The scene workspace always stays dark.">
            <div className="settings-card">
              <Segmented
                label="Appearance"
                value={preferences.appearance}
                onChange={(appearance) => void updatePreferences({ appearance })}
                options={[
                  { value: "system", label: "System", icon: <Smartphone size={14} /> },
                  { value: "light", label: "Light", icon: <SunMedium size={14} /> },
                  { value: "dark", label: "Dark", icon: <Moon size={14} /> },
                ]}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Camera defaults"
            note="Used for new scenes. Existing shots keep their lens."
          >
            <div className="settings-card">
              <RangeControl
                label="Focal length"
                value={camera.focalLengthMm}
                min={14}
                max={120}
                step={1}
                unit="mm"
                onChange={(focalLengthMm) =>
                  void updatePreferences({ camera: { ...camera, focalLengthMm } })
                }
              />
              <label className="field">
                <span>Sensor</span>
                <select
                  value={sensor}
                  onChange={(event) => {
                    const preset = Object.values(SENSOR_PRESETS).find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    if (preset)
                      void updatePreferences({
                        camera: {
                          ...camera,
                          sensorWidthMm: preset.widthMm,
                          sensorHeightMm: preset.heightMm,
                        },
                      });
                  }}
                >
                  {sensor === "custom" && <option value="custom">Custom</option>}
                  {Object.values(SENSOR_PRESETS).map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="chip-row" role="radiogroup" aria-label="Default aspect ratio">
                {ASPECT_OPTIONS.map((ratio) => (
                  <button
                    key={ratio}
                    role="radio"
                    aria-checked={Math.abs(camera.aspectRatio - ratio) < 0.01}
                    className={`chip${Math.abs(camera.aspectRatio - ratio) < 0.01 ? " is-active" : ""}`}
                    onClick={() =>
                      void updatePreferences({ camera: { ...camera, aspectRatio: ratio } })
                    }
                  >
                    {aspectLabel(ratio)}
                  </button>
                ))}
              </div>
            </div>
            {presets.length > 0 && (
              <div className="list-group settings-presets">
                {presets.map((preset) => (
                  <div className="list-row" key={preset.id}>
                    <span className="list-row__main">
                      {preset.name}
                      <small>
                        {preset.focalLengthMm}mm · {aspectLabel(preset.aspectRatio)}
                      </small>
                    </span>
                    <button
                      className="icon-btn"
                      aria-label={`Delete preset ${preset.name}`}
                      onClick={() => void services.deletePreset(preset.id)}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection title="Accessibility">
            <div className="settings-card">
              <Toggle
                label="Reduce motion"
                description="Removes screen and sheet animations."
                checked={preferences.reduceMotion}
                onChange={(reduceMotion) => void updatePreferences({ reduceMotion })}
              />
              <Toggle
                label="Haptic feedback"
                checked={preferences.haptics}
                onChange={(haptics) => void updatePreferences({ haptics })}
              />
            </div>
          </SettingsSection>

          <SettingsSection title="Storage">
            <div className="list-group">
              <div className="list-row">
                <HardDrive size={20} />
                <span className="list-row__main">
                  {plural(projects.length, "project")} on this device
                  <small>
                    {usage
                      ? `${formatBytes(usage.usage)} used of ${formatBytes(usage.quota)} available`
                      : "Projects and imported scenes stay on this device."}
                  </small>
                </span>
              </div>
              <button className="list-row" onClick={() => void resetTutorial()}>
                <GraduationCap size={20} />
                <span className="list-row__main">
                  {tutorial ? "Reset tutorial project" : "Add tutorial project"}
                  <small>Doesn’t count toward the free project.</small>
                </span>
                <ChevronRight size={18} />
              </button>
            </div>
            {message && (
              <p className="meta" role="status">
                {message}
              </p>
            )}
          </SettingsSection>

          {downloads.length > 0 && (
            <SettingsSection
              title="Downloaded scenes"
              note="Kept for offline use. Removing one never changes your projects; it loads from the internet again when needed."
            >
              <div className="list-group">
                {downloads.map((row) => {
                  const title =
                    SCENE_GALLERY.find(
                      (scene) => scene.descriptor.asset.versionId === row.versionId,
                    )?.title ?? "Older scene version";
                  return (
                    <div className="list-row" key={row.versionId}>
                      <HardDrive size={20} />
                      <span className="list-row__main">
                        {title}
                        <small>{formatBytes(row.byteSize)}</small>
                      </span>
                      <button
                        className="icon-btn"
                        aria-label={`Remove ${title} download`}
                        onClick={() => setRemoving({ versionId: row.versionId, title })}
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </SettingsSection>
          )}

          <SettingsSection
            title="Account & backup"
            note="Optional. Oculo works fully without an account."
          >
            <div className="list-group">
              <button
                className="list-row"
                aria-label="Account"
                onClick={() => setAccountOpen(true)}
              >
                <User size={20} />
                <span className="list-row__main">
                  {signedIn ? "Account" : "Sign in to back up"}
                  <small>
                    {authState.status === "signed-in"
                      ? (authState.user.email ?? "Signed in")
                      : authState.status === "unavailable"
                        ? "Backup isn’t available in this build."
                        : "Back up project metadata and shot images."}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            </div>
          </SettingsSection>

          <SettingsSection title="Oculo Pro">
            <div className="list-group">
              <button
                className="list-row"
                aria-label={purchase.isPro ? "Oculo Pro" : "Upgrade"}
                onClick={() => services.setPaywallOpen(true)}
              >
                {purchase.isPro ? <BadgeCheck size={20} /> : <Sparkles size={20} />}
                <span className="list-row__main">
                  {purchase.isPro ? "Pro is active" : "Unlock unlimited projects"}
                  <small>Purchase, restore purchases, and availability</small>
                </span>
                <ChevronRight size={18} />
              </button>
            </div>
          </SettingsSection>

          <SettingsSection title="Support & legal">
            <div className="settings-card settings-links">
              <ReleaseLinks />
            </div>
          </SettingsSection>
        </div>
      </div>

      {removing && (
        <ConfirmSheet
          title={`Remove ${removing.title}?`}
          message="The downloaded scene is removed from this device. Projects that use it keep their shots, and the scene loads from the internet again when you open it."
          confirmLabel="Remove download"
          onConfirm={() => void removeDownload(removing.versionId)}
          onClose={() => setRemoving(null)}
        />
      )}
      {accountOpen && (
        <AccountSheet
          auth={services.auth}
          authState={authState}
          syncState={services.syncState}
          onSignOut={services.signOut}
          onDeleteAccount={services.deleteAccount}
          onClose={() => setAccountOpen(false)}
          {...(services.synced
            ? {
                backup: {
                  listProjects: () => services.synced!.listBackupCandidates(),
                  backUp: (ids: readonly string[]) => services.synced!.adoptLocalProjects(ids),
                  retrySync: () => services.synced!.syncNow(),
                  listConflicts: () => services.synced!.listConflicts(),
                  keepBoth: (id: string) => services.synced!.recoverConflict(id),
                },
              }
            : {})}
        />
      )}
    </div>
  );
}

function SettingsSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <h2 className="eyebrow">{title}</h2>
      {note && <p className="meta">{note}</p>}
      {children}
    </section>
  );
}
