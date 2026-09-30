import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDownUp,
  BadgeCheck,
  Copy,
  Film,
  GraduationCap,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useAppServices } from "../app/AppServices";
import { SCENE_GALLERY } from "../config/sceneCatalog";
import { useNavigation } from "../navigation/Navigation";
import {
  renameProject,
  searchProjects,
  sortProjects,
  summarizeProject,
  type GallerySort,
} from "../services/projectFactory";
import { createTutorialProject } from "../services/tutorial";
import type { Project } from "../types/project";
import { formatRelativeTime, plural } from "../ui/controls";
import { ActionSheet, ConfirmSheet, Sheet } from "../ui/Sheet";
import { useLongPress } from "../ui/useLongPress";
import { useReveal } from "../ui/useReveal";
import { useScrollEdge } from "../ui/useScrollEdge";
import "./screens.css";

const SORT_LABELS: Record<GallerySort, string> = {
  recent: "Recently edited",
  name: "Name",
  shots: "Shot count",
};

// The staggered entrance plays once per app launch, not on every return to the gallery.
let galleryHasEntered = false;

export function GalleryScreen() {
  const services = useAppServices();
  const { projects, projectsLoaded, libraryError, refreshLibrary, preferences, purchase } =
    services;
  const navigation = useNavigation();
  const scrollEdge = useScrollEdge();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sheet, setSheet] = useState<
    | { kind: "sort" }
    | { kind: "menu"; project: Project }
    | { kind: "rename"; project: Project }
    | { kind: "delete"; project: Project }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stagger] = useState(() => !galleryHasEntered);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (projectsLoaded) galleryHasEntered = true;
  }, [projectsLoaded]);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const visible = useMemo(
    () => sortProjects(searchProjects(projects, query), preferences.gallerySort),
    [projects, query, preferences.gallerySort],
  );

  const run = async (operation: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      setSheet(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const startNewProject = async () => {
    try {
      if (await services.canCreateProject()) navigation.push({ name: "scenes" });
    } catch {
      setError("Saved projects could not be checked. Please retry.");
    }
  };

  const duplicate = (project: Project) =>
    void run(async () => {
      if (!(await services.canCreateProject())) return;
      await services.local.duplicateProject(
        project.id,
        crypto.randomUUID(),
        `${project.name} (copy)`,
      );
      await refreshLibrary();
      if (services.synced) void services.synced.flushDirty();
    }, "Project could not be duplicated.");

  const addTutorial = () =>
    void run(async () => {
      await services.store.put(createTutorialProject());
      await services.updatePreferences({ tutorialSeeded: true });
      await refreshLibrary();
    }, "The tutorial could not be added.");

  const hasTutorial = projects.some((project) => project.tutorial);
  useReveal(gridRef, ":scope > li", `${visible.length}:${preferences.gallerySort}`);

  return (
    <div className="screen gallery-screen">
      <header className="app-bar gallery-bar">
        <span className="wordmark-small">Oculo</span>
        <span className="app-bar__title" />
        <button
          className={`chip${purchase.isPro ? " is-active" : ""}`}
          aria-label={purchase.isPro ? "Oculo Pro" : "Upgrade"}
          onClick={() => services.setPaywallOpen(true)}
        >
          {purchase.isPro ? <BadgeCheck size={14} /> : <Sparkles size={14} />}
          {purchase.isPro ? "Pro" : "Upgrade"}
        </button>
      </header>

      <div className="screen-scroll">
        <div className="scroll-edge" ref={scrollEdge} aria-hidden="true" />
        <div>
          <h1 className="large-title">Projects</h1>
          {projectsLoaded && visible.length > 0 && !query && (
            <p className="gallery-lede">
              {plural(projects.length, "project")} ·{" "}
              {plural(
                projects.reduce((total, project) => total + project.scenes.length, 0),
                "scene",
              )}
            </p>
          )}
          {searchOpen && (
            <label className="search-field gallery-search">
              <Search size={18} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                aria-label="Search projects and scenes"
                placeholder="Search projects and scenes"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          {(libraryError || error) && (
            <div className="inline-alert" role="alert">
              <span>{error || libraryError}</span>
              {libraryError && !error && (
                <button className="btn btn--small btn--ghost" onClick={() => void refreshLibrary()}>
                  Retry
                </button>
              )}
            </div>
          )}

          {!projectsLoaded ? (
            <div className="card-grid" aria-hidden="true">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="skeleton project-skeleton" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            query ? (
              <div className="empty-state">
                <Film size={32} />
                <p>No projects match “{query}”.</p>
              </div>
            ) : (
              <section className="gallery-hero" aria-labelledby="gallery-hero-title">
                <div className="gallery-hero__fan" aria-hidden="true">
                  {SCENE_GALLERY.slice(0, 5).map((scene, index) => (
                    <img
                      key={scene.id}
                      src={scene.thumbnail}
                      alt=""
                      draggable={false}
                      style={{ "--i": index - 2 } as CSSProperties}
                    />
                  ))}
                </div>
                <p className="gallery-hero__eyebrow">Oculo</p>
                <h2 id="gallery-hero-title" className="gallery-hero__title">
                  Plan your first <span className="gradient-text">shoot.</span>
                </h2>
                <p className="gallery-hero__lede">
                  Walk a captured scene, frame every shot on the lens you&apos;ll use, and share the
                  plan with your crew.
                </p>
                <div className="gallery-hero__actions">
                  <button className="btn btn--primary" onClick={() => void startNewProject()}>
                    <Plus size={18} /> New project
                  </button>
                  {!hasTutorial && (
                    <button className="btn btn--link" disabled={busy} onClick={addTutorial}>
                      <GraduationCap size={18} /> Open the tutorial
                    </button>
                  )}
                </div>
              </section>
            )
          ) : (
            <ul ref={gridRef} className={`card-grid project-grid${stagger ? " stagger-in" : ""}`}>
              {visible.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  index={index}
                  onOpen={() => navigation.push({ name: "project", projectId: project.id })}
                  onMenu={() => setSheet({ kind: "menu", project })}
                />
              ))}
            </ul>
          )}
          {!purchase.isPro && projectsLoaded && projects.length > 0 && (
            <p className="meta gallery-note">
              Free keeps one saved project (the tutorial doesn’t count). Pro removes the limit.
            </p>
          )}
        </div>
      </div>

      <nav className="bottom-bar" aria-label="Project actions">
        <button
          className="icon-btn icon-btn--filled"
          aria-label={searchOpen ? "Close search" : "Search projects"}
          aria-pressed={searchOpen}
          onClick={() => {
            setSearchOpen((open) => !open);
            setQuery("");
          }}
        >
          {searchOpen ? <X size={20} /> : <Search size={20} />}
        </button>
        <button
          className="icon-btn icon-btn--filled"
          aria-label={`Sort projects: ${SORT_LABELS[preferences.gallerySort]}`}
          onClick={() => setSheet({ kind: "sort" })}
        >
          <ArrowDownUp size={20} />
        </button>
        <button className="btn btn--primary" onClick={() => void startNewProject()}>
          <Plus size={20} /> New project
        </button>
        <button
          className="icon-btn icon-btn--filled"
          aria-label="Settings"
          onClick={() => navigation.push({ name: "settings" })}
        >
          <Settings size={20} />
        </button>
      </nav>

      {sheet?.kind === "sort" && (
        <ActionSheet
          title="Sort projects"
          onClose={() => setSheet(null)}
          actions={(Object.keys(SORT_LABELS) as GallerySort[]).map((sort) => ({
            label: `${SORT_LABELS[sort]}${sort === preferences.gallerySort ? " ✓" : ""}`,
            onSelect: () => void services.updatePreferences({ gallerySort: sort }),
          }))}
        />
      )}
      {sheet?.kind === "menu" && (
        <ActionSheet
          title={sheet.project.name}
          onClose={() => setSheet(null)}
          actions={[
            {
              label: "Rename",
              icon: <Pencil size={18} />,
              onSelect: () => setSheet({ kind: "rename", project: sheet.project }),
            },
            {
              label: "Duplicate",
              icon: <Copy size={18} />,
              onSelect: () => duplicate(sheet.project),
            },
            {
              label: "Delete",
              icon: <Trash2 size={18} />,
              destructive: true,
              onSelect: () => setSheet({ kind: "delete", project: sheet.project }),
            },
          ]}
        />
      )}
      {sheet?.kind === "rename" && (
        <RenameSheet
          title="Rename project"
          initial={sheet.project.name}
          busy={busy}
          error={error}
          onClose={() => setSheet(null)}
          onSave={(name) =>
            void run(async () => {
              await services.store.put(renameProject(sheet.project, name));
              await refreshLibrary();
            }, "Project could not be renamed.")
          }
        />
      )}
      {sheet?.kind === "delete" && (
        <ConfirmSheet
          title="Delete project"
          message={`Delete “${sheet.project.name}”, its ${plural(
            sheet.project.scenes.length,
            "scene",
          )}, and saved shots? This cannot be undone. Scene files used by other projects are kept.`}
          confirmLabel="Delete project"
          cancelLabel="Keep project"
          busy={busy}
          error={error}
          onClose={() => setSheet(null)}
          onConfirm={() =>
            void run(async () => {
              await services.store.delete(sheet.project.id);
              await refreshLibrary();
            }, "Project could not be deleted.")
          }
        />
      )}
    </div>
  );
}

function ProjectCard({
  project,
  index,
  onOpen,
  onMenu,
}: {
  project: Project;
  index: number;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const summary = summarizeProject(project);
  const longPress = useLongPress(onMenu);
  return (
    <li className="card project-card" style={{ "--i": index } as CSSProperties}>
      <button
        className="card-button"
        aria-label={`Open ${project.name}`}
        onClick={() => {
          if (!longPress.consumed()) onOpen();
        }}
        {...longPress.handlers}
      >
        <span className="card__thumb">
          {summary.thumbnail ? (
            <img src={summary.thumbnail} alt="" draggable={false} />
          ) : (
            <Film size={28} />
          )}
        </span>
        <span className="card__badges">
          {project.tutorial && <span className="badge badge--accent">Tutorial</span>}
          {summary.onDeviceOnly && <span className="badge">On device</span>}
        </span>
        <span className="card__body">
          <span className="card__title">{project.name}</span>
          <span className="meta">
            {plural(summary.sceneCount, "scene")} · {plural(summary.shotCount, "shot")}
          </span>
          <span className="meta">{formatRelativeTime(project.updatedAt)}</span>
        </span>
      </button>
      <button
        className="icon-btn icon-btn--overlay card__menu"
        aria-label={`More actions for ${project.name}`}
        onClick={onMenu}
      >
        <MoreHorizontal size={18} />
      </button>
    </li>
  );
}

export function RenameSheet({
  title,
  initial,
  busy,
  error,
  onSave,
  onClose,
}: {
  title: string;
  initial: string;
  busy: boolean;
  error: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Sheet
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <button
          className="btn btn--primary btn--block"
          disabled={busy || !name.trim()}
          onClick={() => onSave(name)}
        >
          {busy ? "Saving…" : "Save name"}
        </button>
      }
    >
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          maxLength={80}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) onSave(name);
          }}
        />
      </label>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
