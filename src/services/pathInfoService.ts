import type { Track } from "../core/types";

// A single record from mediamtx GET /v3/paths/list -> items[]. The fields we read are
// `name` and `tracks2`; everything else (source, readers, bytes, ...) is dropped.
interface PathListItem {
  name: string;
  tracks2?: Array<{ codec: string; codecProps?: Track["codecProps"] }>;
}

interface PathsListResponse {
  items?: PathListItem[];
}

interface FetchResult {
  ok: boolean;
  text: string;
}

export interface PathInfoServiceOptions {
  // Override the mediamtx REST endpoint. Defaults to the standard local port.
  endpoint?: string;
  // Injectable fetch used in tests / for mock overrides.
  fetcher?: () => Promise<FetchResult>;
  // When true, skip the network and serve mockOutput verbatim so the panel can run
  // against a static fixture (mirrors the monitors' useMockData flag).
  useMockData?: boolean;
  // Raw JSON body served in mock mode (contents of /v3/paths/list).
  mockOutput?: string;
}

// Fetches mediamtx path codec info once per process and answers synchronously from a cache.
//
// mediamtx exposes tracks via GET /v3/paths/list, which returns *all* paths (including
// not-ready ones with empty tracks2). We fetch the whole list lazily on the first time a
// logical stream needs track info, then cache per path name so the polling loop never
// re-fetches for a path we already know. A path that was requested but absent from the
// mediamtx list (only happens for synthetic nginx-only `stream-N` ids that mediamtx does
// not back) is cached as an empty entry so it doesn't trigger a refetch every tick; a real
// path whose publisher connects later was never requested before, so its first request
// still drives a fresh fetch.
export class PathInfoService {
  private readonly endpoint: string;
  private readonly fetcher?: () => Promise<FetchResult>;
  private readonly useMockData: boolean;
  private readonly mockOutput: string;

  private readonly cache = new Map<string, Track[]>();
  private pending: Promise<void> | null = null;
  private everFetched = false;

  public constructor(options: PathInfoServiceOptions = {}) {
    this.endpoint = options.endpoint ?? "http://localhost:9997/v3/paths/list";
    this.fetcher = options.fetcher;
    this.useMockData = options.useMockData ?? false;
    this.mockOutput = options.mockOutput ?? '{"items":[]}';
  }

  // Make sure track info for the given paths is in the cache. Triggers at most one real
  // fetch per batch of unknown names; once a name is cached (with tracks or as empty) it
  // never triggers a fetch on its own again.
  public async ensurePaths(paths: Iterable<string>): Promise<void> {
    const requested = new Set(paths);
    if (requested.size === 0) return;

    // Coalesce concurrent callers onto the in-flight fetch, then re-evaluate once it lands.
    while (this.pending) {
      await this.pending;
    }
    if (!this.shouldFetch(requested)) return;

    this.pending = this.fetchAll();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }

    // Negative-cache requested names mediamtx doesn't know about (synthetic `stream-N`),
    // so they don't force a refetch every poll tick.
    for (const name of requested) {
      if (!this.cache.has(name)) {
        this.cache.set(name, []);
      }
    }
  }

  // Synchronous cache lookup; returns undefined for paths we've never been asked about,
  // and [] for known-but-trackless paths (callers render nothing for either).
  public getTracks(path: string): Track[] | undefined {
    return this.cache.get(path);
  }

  private shouldFetch(paths: Set<string>): boolean {
    if (!this.everFetched) return true;
    for (const path of paths) {
      if (!this.cache.has(path)) return true;
    }
    return false;
  }

  private async fetchAll(): Promise<void> {
    let text: string;
    if (this.useMockData) {
      text = this.mockOutput;
    } else {
      const result = await (this.fetcher ?? PathInfoService.defaultFetch(this.endpoint))();
      this.everFetched = true;
      if (!result.ok) return;
      text = result.text;
    }
    this.everFetched = true;

    let parsed: PathsListResponse;
    try {
      parsed = JSON.parse(text) as PathsListResponse;
    } catch {
      return;
    }

    const items = parsed.items ?? [];
    for (const item of items) {
      const tracks: Track[] = [];
      for (const raw of item.tracks2 ?? []) {
        if (!raw || !raw.codec) continue;
        tracks.push({ codec: raw.codec, codecProps: raw.codecProps });
      }
      // Overwrite on every fetch so a re-fetch (triggered by a newly-seen path) refreshes
      // tracks that may have populated since the previous fetch.
      this.cache.set(item.name, tracks);
    }
  }

  private static defaultFetch(endpoint: string): () => Promise<FetchResult> {
    return async () => {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) {
          return { ok: false, text: "" };
        }
        return { ok: true, text: await response.text() };
      } catch {
        return { ok: false, text: "" };
      }
    };
  }
}
