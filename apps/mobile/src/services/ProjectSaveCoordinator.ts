import type { Project } from "../types/project";

export type ProjectSaveState = Readonly<{
  status: "saving" | "saved" | "error";
  error?: string;
}>;

/**
 * Owns one editor's local save queue. Every edit is copied before it enters
 * the queue, and writes never overlap. A completed older write cannot mark
 * newer edits as saved. Cloud sync remains the store's separate concern.
 */
export class ProjectSaveCoordinator<T extends { id: string } = Project> {
  private state: ProjectSaveState = { status: "saved" };
  private readonly listeners = new Set<(state: ProjectSaveState) => void>();
  private latest: { revision: number; project: T } | undefined;
  private savedRevision = 0;
  private running: Promise<void> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly store: { put(value: T): Promise<void> }) {}

  getState(): ProjectSaveState {
    return this.state;
  }

  subscribe(listener: (state: ProjectSaveState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Debounce navigation edits, but keep saving during continuous movement. */
  schedule(project: T): void {
    this.enqueue(project);
    if (this.running !== undefined) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.startInBackground(), 350);
    this.maxWaitTimer ??= setTimeout(() => this.startInBackground(), 1000);
  }

  /**
   * Save a supplied snapshot immediately, or flush the pending snapshot.
   * Resolves only after all edits queued during the write are committed.
   * Callers must handle rejection before leaving the editor or claiming success.
   */
  flush(project?: T): Promise<void> {
    if (project !== undefined) this.enqueue(project);
    this.clearTimers();
    if (this.running !== undefined) return this.running;
    if (this.latest === undefined || this.latest.revision === this.savedRevision) {
      return Promise.resolve();
    }

    this.setState({ status: "saving" });
    const running = this.drainUntilSettled();
    this.running = running;
    // Rejection stays available to explicit callers while background saves
    // can safely rely on the error state instead.
    void running.catch(() => undefined);
    return running;
  }

  retry(): Promise<void> {
    return this.flush();
  }

  private enqueue(project: T): void {
    if (this.latest !== undefined && this.latest.project.id !== project.id) {
      throw new Error("A project save coordinator cannot be shared between editors");
    }
    this.latest = {
      revision: (this.latest?.revision ?? 0) + 1,
      project: structuredClone(project),
    };
    this.setState({ status: "saving" });
  }

  private startInBackground(): void {
    void this.flush().catch(() => {
      // The error remains visible in state and the newest snapshot is retained.
    });
  }

  private async drainUntilSettled(): Promise<void> {
    try {
      do {
        await this.drain();
        // A saved-state subscriber (or its queued microtask) can add an edit
        // while drain finishes. Keep that edit in this flush's commit barrier.
      } while (this.latest !== undefined && this.latest.revision > this.savedRevision);
    } finally {
      // Clear ownership before settling the promise, without another microtask
      // gap in which schedule could mistake a completed write for active work.
      this.running = undefined;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.latest !== undefined && this.latest.revision > this.savedRevision) {
        const snapshot = this.latest;
        await this.store.put(snapshot.project);
        this.savedRevision = snapshot.revision;
      }
      this.setState({ status: "saved" });
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("Could not save this project");
      this.setState({ status: "error", error: error.message });
      throw error;
    }
  }

  private clearTimers(): void {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.maxWaitTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
  }

  private setState(next: ProjectSaveState): void {
    if (next.status === this.state.status && next.error === this.state.error) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
