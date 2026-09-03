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
  // Minimum time between automatic refetches of /v3/paths/list. When a requested path is
  // cached but its track info is still empty (mediamtx hadn't parsed `tracks2` yet on the
  // first fetch), this bounds how often we re-pull the whole list so the codec info can
  // self-heal. Defaults to 20s — a single localhost request per window, traded for not
  // blanking codec info forever when the first fetch raced the publisher.
  emptyRefetchIntervalMs?: number;
  // Injectable clock (defaults to Date.now) so the empty-refetch throttle is testable.
  now?: () => number;
}

// Fetches mediamtx path codec info and answers synchronously from a cache.
//
// mediamtx exposes tracks via GET /v3/paths/list, which returns *all* paths (including
// not-ready ones whose `tracks2` is still empty — the publisher hasn't sent enough data for
// mediamtx to parse the codecs yet). We fetch the whole list lazily the first time a
// logical stream needs track info, then cache per path name so the polling loop doesn't
// re-fetch for a path we already have tracks for.
//
// Empty cache entries are NOT sticky forever. The first fetch often races ahead of the
// publisher, so a path lands with no tracks even though mediamtx will populate `tracks2`
// moments later. Rather than blank that codec info indefinitely, shouldFetch re-pulls the
// whole list (one request) when a still-requested path is cached empty and the throttle
// window has elapsed — so the info self-heals once mediamtx has it. A path mediamtx's list
// never includes (synthetic nginx-only `stream-N` ids it doesn't back) is cached empty for
// the same reason: it renders nothing and is rate-limited by the same throttle instead of
// forcing a per-tick refetch through the "never seen" branch.
export class PathInfoService {
  private readonly endpoint: string;
  private readonly fetcher?: () => Promise<FetchResult>;
  private readonly useMockData: boolean;
  private readonly mockOutput: string;
  private readonly emptyRefetchIntervalMs: number;
  private readonly now: () => number;

  private readonly cache = new Map<string, Track[]>();
  private pending: Promise<void> | null = null;
  private everFetched = false;
  private lastFetchAt = 0;

  public constructor(options: PathInfoServiceOptions = {}) {
    this.endpoint = options.endpoint ?? "http://localhost:9997/v3/paths/list";
    this.fetcher = options.fetcher;
    this.useMockData = options.useMockData ?? false;
    this.mockOutput = options.mockOutput ?? '{"items":[]}';
    this.emptyRefetchIntervalMs = options.emptyRefetchIntervalMs ?? 20000;
    this.now = options.now ?? Date.now;
  }

  // Make sure track info for the given paths is in the cache. Triggers at most one real
  // fetch per batch of unknown names; a name cached *with tracks* never triggers another on
  // its own, while a name cached empty self-heals on the throttle window (see shouldFetch).
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

    // Ensure every requested name has a cache entry. Names mediamtx's list didn't include
    // (synthetic nginx-only `stream-N`, or a real path whose publisher hasn't connected yet)
    // become empty here so the caller renders nothing — and so the throttled empty-refetch
    // in shouldFetch (not the per-tick "never seen" branch) governs when we re-pull the list.
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

  // Fetch when we never have, or when a requested name is unknown — and, crucially, when a
  // requested name is cached but still empty and the throttle window has elapsed. That last
  // case is what heals a path that was fetched before its publisher had fed mediamtx enough
  // data to populate `tracks2`; without it, the empty entry from the racing first fetch
  // sticks forever (no per-tick re-fetch for known paths) and codec info never appears.
  private shouldFetch(paths: Set<string>): boolean {
    if (!this.everFetched) return true;
    const throttleOpen = this.now() - this.lastFetchAt >= this.emptyRefetchIntervalMs;
    for (const path of paths) {
      const cached = this.cache.get(path);
      if (cached === undefined) return true;
      if (cached.length === 0 && throttleOpen) return true;
    }
    return false;
  }

  private async fetchAll(): Promise<void> {
    // Stamp at the start so the throttle counts from the last fetch attempt (success or
    // failure): a down mediamtx retries after the window instead of every tick, and a
    // successful pull resets the clock for the next empty-refetch pass.
    this.lastFetchAt = this.now();
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
      // Overwrite on every fetch so a re-fetch (triggered by a newly-seen path or the
      // empty-refetch throttle) refreshes tracks that may have populated since the last pull.
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
