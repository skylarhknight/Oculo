import {
  SceneDescriptorSchema,
  migrateScene,
  parseSceneDescriptor,
  type SceneDescriptor,
} from "@oculo/scene-schema";

export interface SceneSource {
  load(signal?: AbortSignal): Promise<SceneDescriptor>;
}

export class BundledSceneSource implements SceneSource {
  constructor(private readonly descriptor: SceneDescriptor) {}

  async load(signal?: AbortSignal): Promise<SceneDescriptor> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    return SceneDescriptorSchema.parse(this.descriptor) as SceneDescriptor;
  }
}

export interface UrlSceneSourceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly init?: Omit<RequestInit, "signal">;
}

export class UrlSceneSource implements SceneSource {
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(
    readonly url: string | URL,
    private readonly options: UrlSceneSourceOptions = {},
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async load(signal?: AbortSignal): Promise<SceneDescriptor> {
    const init: RequestInit = signal ? { ...this.options.init, signal } : { ...this.options.init };
    const response = await this.fetchImplementation(this.url, init);
    if (!response.ok) {
      throw new Error(
        `Unable to load scene descriptor from ${String(this.url)}: ${response.status} ${response.statusText}`,
      );
    }
    const raw: unknown = await response.json();
    if (typeof raw === "object" && raw !== null && "version" in raw)
      return parseSceneDescriptor(raw);
    if (typeof raw === "object" && raw !== null && "splatUrl" in raw) return migrateScene(raw);
    return SceneDescriptorSchema.parse(raw);
  }
}

/*
 * Extension point: a future WorldLabsSceneSource can implement SceneSource and
 * translate the provider's response into SceneDescriptor. Keep provider
 * authentication and SDK-specific behavior outside SceneEngine; no public
 * World Labs browser SDK contract is assumed here.
 */
