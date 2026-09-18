import { isLoopbackRemote } from "../net-addr";
import type { Track } from "../../core/types";

// Options for the mediamtx control-API добивка (per-path GETs). Everything mediamtx
// lives in this collector; grouping layers only call ensurePaths/getTracks/getReaders.
export interface PathInfoOptions {
  // Base URL of the mediamtx control API. Defaults to the standard local port.
  controlBase?: string;
  // Injectable fetches used in tests / for mock overrides.
  pathFetcher?: (path: string) => Promise<FetchResult>;
  forwardFetcher?: (path: string, id: string) => Promise<FetchResult>;
  // Static fixtures served instead of the network when the collector runs with
  // useMockData (mirrors the metrics mockOutputs flag). mockForwards is keyed
  // "path:id"; a missing key behaves like a failed fetch, never the network.
  mockPaths?: Record<string, string>;
  mockForwards?: Record<string, string>;
  // Minimum time between refetches of a path cached empty (mediamtx hadn't parsed
  // `tracks2` yet on the first fetch). Defaults to 20s.
  emptyRefetchIntervalMs?: number;
}

export interface SrtMetrics {
  protocol: "SRT" | "SRTLA";
  target: "INBOUND" | "OUTBOUND";
  stream_id?: string;
  peer_ip: string | null;
  mode: "publish" | "read" | string;

  rtt: number;
  rtt_jitter: number;

  tx_bps: number;
  rx_bps: number;
  link_capacity_bps: number;

  bytes_sent: number;
  bytes_received: number;

  drop_percent: number;

  recv_q: number;
  send_q: number;
  recv_buffer_ms: number;
  send_buffer_ms: number;
  tsbpd_delay_ms: number;

  retrans_total: number;
  flight_size: number;
  flow_window: number;

  health: number;
  is_first_tick: boolean;
}

interface RawSrtMetric {
  id: string;
  path: string;
  remoteAddr: string | null;
  state: string;
  metrics: Record<string, number>;
}

interface ForwardDest {
  id: string;
  path: string;
  protocol: string;
  state: string;
}

interface RtmpConn {
  id: string;
  path: string;
  remoteAddr: string | null;
  state: string;
}

interface SrtPreviousState {
  packets_received_drop: number;
  packets_send_drop: number;
  packets_received: number;
  packets_sent: number;
  packets_retrans: number;
  packets_received_retrans: number;
  tx_bps: number;
  rx_bps: number;
  timestamp: number;
}

interface ThroughputSample {
  bytes_sent: number;
  bytes_received: number;
  timestamp: number;
}

interface RttSample {
  rtt: number;
  timestamp: number;
}

interface CommandExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

interface MockOutput {
  stdout: string;
  elapsedMs?: number;
}

// A single record from mediamtx GET /v3/paths/get/{name}. Only `tracks2`,
// `readers` and the availability timestamp are read; everything else (source,
// bytes, ...) is dropped.
interface PathGetResponse {
  tracks2?: Array<{ codec: string; codecProps?: Track["codecProps"] }>;
  readers?: unknown[];
  // availableTime marks when the stream became available (publisher connected).
  // readyTime is its deprecated predecessor, kept as a fallback for older servers.
  availableTime?: string | null;
  readyTime?: string | null;
}

// A single record from GET /v3/paths/forward-dests/get?path=&id=. Only the live
// socket address is read; mediamtx no longer emits remoteAddr in /metrics even
// while forwarding, so this is the sole source of forward correlation.
interface ForwardGetResponse {
  typeSpecific?: { remoteAddr?: string };
}

interface FetchResult {
  ok: boolean;
  text: string;
}

export type MediamtxCollectResult =
  | {
      success: true;
      metrics: SrtMetrics[];
      forwardMap: Map<string, string>;
      publishMap: Map<string, string>;
    }
  | { success: false; error: string };

export interface MediamtxCollectorOptions {
  metricsFetcher?: () => Promise<CommandExecutionResult>;
  now?: () => number;
  useMockData?: boolean;
  mockOutputs?: Array<string | MockOutput>;
  pathInfo?: PathInfoOptions;
}

// The single source of everything mediamtx: per-tick /metrics (SRT connections,
// forward destinations, RTMP publisher correlation) plus on-demand /v3 path and
// forward details. Steady-state polling stays on /metrics; a path that becomes
// active gets one GET /v3/paths/get/{name} for tracks/readers/stream start, and each active
// (non-idle) forward gets one GET /v3/paths/forward-dests/get?path=&id= for its
// remoteAddr. A forward reconnect mints a fresh mediamtx id, which arrives as a
// cache miss and is refetched automatically; entries whose id vanished from
// /metrics are evicted on the same tick. Stateless across ticks except for the
// rolling health windows and these small caches. Grouping, events and snapshots
// stay in the grouping layer.
export class MediamtxCollector {
  private static readonly RATE_WINDOW_SAMPLE_COUNT = 4;
  private static readonly RTT_WINDOW_SAMPLE_COUNT = 6;
  private readonly states = new Map<string, SrtPreviousState>();
  private readonly throughputSamples = new Map<string, ThroughputSample[]>();
  private readonly rttSamples = new Map<string, RttSample[]>();
  private mockIndex = 0;
  private pendingMockElapsedMs: number | null = null;

  // Per-path details from /v3/paths/get/{name}. A name cached with tracks never
  // refetches on its own; populated entries are dropped when the path goes quiet
  // or republishes (see evictDeadPaths/trackPublishConnections) so the next
  // ensurePaths pulls fresh tracks and a fresh availableTime.
  private readonly pathCache = new Map<string, Track[]>();
  private readonly readersCache = new Map<string, number>();
  private readonly startedAtCache = new Map<string, number>();
  // Publish connection id per path from /metrics. A republish mints a fresh id on
  // the same path, which is the only signal that availableTime changed while the
  // path never left /metrics.
  private readonly pathPublishConn = new Map<string, string>();
  // Forward remoteAddr by "path:id" from forward-dests/get. Keyed by the mediamtx
  // forward id so a reconnect (new id) refetches instead of reusing a stale peer.
  private readonly forwardCache = new Map<string, string>();
  private readonly pendingPath = new Map<string, Promise<void>>();
  private readonly pendingForward = new Map<string, Promise<void>>();
  private lastFetchAt = 0;

  private readonly metricsFetcher: () => Promise<CommandExecutionResult>;
  private readonly now: () => number;
  private readonly useMockData: boolean;
  private readonly mockOutputs: Array<string | MockOutput>;
  private readonly controlBase: string;
  private readonly pathFetcher?: (path: string) => Promise<FetchResult>;
  private readonly forwardFetcher?: (path: string, id: string) => Promise<FetchResult>;
  private readonly mockPaths: Record<string, string>;
  private readonly mockForwards: Record<string, string>;
  private readonly emptyRefetchIntervalMs: number;

  public constructor(options: MediamtxCollectorOptions = {}) {
    this.metricsFetcher = options.metricsFetcher ?? MediamtxCollector.fetchMetrics;
    this.now = options.now ?? Date.now;
    this.useMockData = options.useMockData ?? false;
    this.mockOutputs = options.mockOutputs ?? [];
    this.controlBase = options.pathInfo?.controlBase ?? "http://localhost:9997";
    this.pathFetcher = options.pathInfo?.pathFetcher;
    this.forwardFetcher = options.pathInfo?.forwardFetcher;
    this.mockPaths = options.pathInfo?.mockPaths ?? {};
    this.mockForwards = options.pathInfo?.mockForwards ?? {};
    this.emptyRefetchIntervalMs = options.pathInfo?.emptyRefetchIntervalMs ?? 20000;
  }

  // Make sure track info for the given paths is in the cache. A name cached with
  // tracks never refetches; a name cached empty refetches once the throttle
  // window has elapsed so codec info self-heals when mediamtx populates tracks2
  // after our first (racing) fetch. Failures cache empty and retry next window.
  public async ensurePaths(paths: Iterable<string>): Promise<void> {
    const requested = new Set(paths);
    if (requested.size === 0) return;
    await Promise.all([...requested].map((name) => this.ensurePath(name)));
  }

  // Synchronous cache lookup; returns undefined for paths we've never been asked about,
  // and [] for known-but-trackless paths (callers render nothing for either).
  public getTracks(path: string): Track[] | undefined {
    return this.pathCache.get(path);
  }

  // Reader (viewer/consumer) count from the same per-path payload.
  // Undefined when the path was never fetched or the response had no readers array.
  public getReaders(path: string): number | undefined {
    return this.readersCache.get(path);
  }

  // Real stream start from mediamtx (paths/get availableTime). Null when the path
  // was never fetched, isn't available, or carried no parseable timestamp;
  // callers fall back to first-sight time.
  public getStartedAt(path: string): number | null {
    return this.startedAtCache.get(path) ?? null;
  }

  public async collect(): Promise<MediamtxCollectResult> {
    const commandResult = await this.getMetricsResult();

    if (!commandResult.success) {
      return {
        success: false,
        error: commandResult.error ?? commandResult.stderr ?? "Failed to fetch SRT metrics",
      };
    }

    try {
      const rawData = this.parse(commandResult.stdout);
      this.evictDeadConnections(rawData.map((raw) => raw.id));
      const srtlaPaths = this.parseSrtlaPaths(commandResult.stdout);
      const dests = this.parseForwardDestinations(commandResult.stdout);
      const rtmpConns = this.parseRtmpConnections(commandResult.stdout);
      this.trackPublishConnections(rawData, rtmpConns);
      this.evictDeadPaths(MediamtxCollector.collectActivePaths(rawData, dests, rtmpConns));
      await this.ensureForwards(dests);
      const metrics = rawData.map((raw) => this.calculateHealth(raw, srtlaPaths));
      const forwardMap = this.buildForwardMap(dests);
      const publishMap = this.buildPublishMap(rtmpConns);

      return { success: true, metrics, forwardMap, publishMap };
    } catch (error) {
      return {
        success: false,
        error: `Failed to parse SRT metrics: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  // Parse `key="value"` pairs out of a `{...}` label segment into a dict, so the
  // parsers below don't pin label order or presence: mediamtx adds labels (pos,
  // type) and deprecates others (remoteAddr, protocol) across versions, and a
  // positional regex silently drops the whole connection when the shape shifts.
  private static parseLabels(segment: string): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const match of segment.matchAll(/(\w+)="([^"]*)"/g)) {
      labels[match[1]!] = match[2]!;
    }
    return labels;
  }

  // Paths with anything worth keeping per-path details for: SRT connections,
  // actively-forwarding destinations, and RTMP connections (publishers and
  // readers alike — a watched path stays watched).
  private static collectActivePaths(
    raw: RawSrtMetric[],
    dests: ForwardDest[],
    rtmpConns: RtmpConn[],
  ): Set<string> {
    const active = new Set<string>();
    for (const conn of raw) active.add(conn.path);
    for (const dest of dests) {
      if (dest.state !== "idle") active.add(dest.path);
    }
    for (const conn of rtmpConns) active.add(conn.path);
    return active;
  }

  private static parseTime(value: unknown): number | null {
    if (typeof value !== "string" || !value) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }

  public parse(output: string): RawSrtMetric[] {
    const lines = output.split("\n");
    const connections = new Map<string, RawSrtMetric>();

    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;

      // Only srt_conns* metrics describe SRT connections. mediamtx emits rtmp_conns* with the
      // same label shape (id/path/remoteAddr/state); the bare [a-z_]+ prefix would treat an
      // internal RTMP reader (e.g. remoteAddr="127.0.0.1:...") as a bogus SRT outbound with
      // all-zero metrics. Pin the prefix to srt_conns so non-SRT connection metrics are ignored.
      const match = line.match(/^(srt_conns[a-z_]*)\{([^}]*)\}\s+([0-9.\-e+]+)/);

      if (!match) {
        continue;
      }

      const metricName = match[1]!;
      const labels = MediamtxCollector.parseLabels(match[2]!);
      const id = labels["id"];
      const path = labels["path"];
      const state = labels["state"];
      // Derivative counters share the base line's labels; skip label-less aggregates.
      if (!id || !path || !state) continue;
      const value = parseFloat(match[3]!);

      if (!connections.has(id)) {
        connections.set(id, {
          id,
          path,
          // remoteAddr is deprecated upstream and may vanish; a connection without one
          // is still counted, with a null peer.
          remoteAddr: labels["remoteAddr"] ?? null,
          state,
          metrics: {},
        });
      }

      connections.get(id)!.metrics[metricName] = value;
    }

    return [...connections.values()];
  }

  // Collect the set of paths backed by an SRTLA group. mediamtx emits a `path` label on the
  // base `srtla_groups{...}` counter for each SRTLA group; any SRT connection whose path
  // matches one of these is an SRTLA connection (a sub-variant of SRT), not plain SRT.
  // Derivatives like `srtla_groups_conns_active{...}` share the prefix but carry no new path,
  // and the bare `srtla_groups 0` (no labels) carries none at all, so pinning the regex to
  // `srtla_groups{` skips both.
  public parseSrtlaPaths(output: string): Set<string> {
    const paths = new Set<string>();

    for (const line of output.split("\n")) {
      const match = line.match(/^srtla_groups\{[^}]*path="([^"]+)"[^}]*\}\s+\d+/);
      if (match) {
        paths.add(match[1]!);
      }
    }

    return paths;
  }

  public parseForwardDestinations(output: string): ForwardDest[] {
    const dests = new Map<string, ForwardDest>();

    for (const line of output.split("\n")) {
      // Only the base counter line starts with `forward_dests{`; skip derivatives like
      // `forward_dests_outbound_bytes{...}`. The `protocol` label is deprecated and
      // superseded by `type`; `pos` is ignored. remoteAddr is NOT read here even when
      // present: current mediamtx omits it from /metrics entirely (even while
      // forwarding) and the live socket comes from forward-dests/get instead.
      const match = line.match(/^forward_dests\{([^}]*)\}\s+\d+/);
      if (!match) continue;

      const labels = MediamtxCollector.parseLabels(match[1]!);
      const id = labels["id"];
      const path = labels["path"];
      const state = labels["state"];
      if (!id || !path || !state) continue;
      if (dests.has(id)) continue;

      dests.set(id, {
        id,
        path,
        protocol: labels["type"] ?? labels["protocol"] ?? "",
        state,
      });
    }

    return [...dests.values()];
  }

  private buildForwardMap(dests: ForwardDest[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const dest of dests) {
      // Only actively-forwarding destinations correlate; idle ones must not. The peer
      // comes from the forward-dests/get cache (see ensureForwards), never from labels.
      if (dest.state === "idle") continue;
      const remoteAddr = this.forwardCache.get(`${dest.path}:${dest.id}`);
      if (remoteAddr) {
        map.set(remoteAddr, dest.path);
      }
    }
    return map;
  }

  // Fetch forward details for every active destination missing from the cache. A
  // reconnect mints a fresh mediamtx id, so it arrives as a cache miss and is
  // fetched; ids that vanished from /metrics are evicted on the same pass. At most
  // one fetch per id; a failed fetch simply retries next tick and never fails
  // collect().
  private async ensureForwards(dests: ForwardDest[]): Promise<void> {
    const live = new Set<string>();
    const tasks: Array<Promise<void>> = [];

    for (const dest of dests) {
      if (dest.state === "idle") continue;
      const key = `${dest.path}:${dest.id}`;
      live.add(key);
      if (this.forwardCache.has(key) || this.pendingForward.has(key)) continue;

      const task = this.fetchForward(dest.path, dest.id, key);
      this.pendingForward.set(key, task);
      tasks.push(
        task.finally(() => {
          this.pendingForward.delete(key);
        }),
      );
    }

    for (const key of this.forwardCache.keys()) {
      if (!live.has(key)) this.forwardCache.delete(key);
    }

    await Promise.all(tasks);
  }

  private async fetchForward(path: string, id: string, key: string): Promise<void> {
    const result = await this.resolveForward(path, id);
    if (!result.ok) return;
    try {
      const parsed = JSON.parse(result.text) as ForwardGetResponse;
      const remoteAddr = parsed.typeSpecific?.remoteAddr;
      // ponytail: no addr yet (connecting forward) stays uncached so the next tick retries.
      if (typeof remoteAddr !== "string" || !remoteAddr) return;
      this.forwardCache.set(key, remoteAddr);
    } catch {
      // Malformed body: leave uncached so the next tick retries.
    }
  }

  private async resolveForward(path: string, id: string): Promise<FetchResult> {
    if (this.forwardFetcher) return this.forwardFetcher(path, id);
    if (this.useMockData) {
      const text = this.mockForwards[`${path}:${id}`];
      return text === undefined ? { ok: false, text: "" } : { ok: true, text };
    }
    try {
      const response = await fetch(
        `${this.controlBase}/v3/paths/forward-dests/get?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`,
      );
      if (!response.ok) return { ok: false, text: "" };
      return { ok: true, text: await response.text() };
    } catch {
      return { ok: false, text: "" };
    }
  }

  // Parse the rtmp_conns metrics section into per-connection identity records. Like the SRT
  // parser above, only base `rtmp_conns{...}` lines carry the label set; derivatives such as
  // `rtmp_conns_inbound_bytes{...}` are skipped by pinning the prefix to `rtmp_conns{`.
  public parseRtmpConnections(output: string): RtmpConn[] {
    const conns = new Map<string, RtmpConn>();

    for (const line of output.split("\n")) {
      const match = line.match(/^rtmp_conns\{([^}]*)\}\s+\d+/);
      if (!match) continue;

      const labels = MediamtxCollector.parseLabels(match[1]!);
      const id = labels["id"];
      const path = labels["path"];
      const state = labels["state"];
      if (!id || !path || !state) continue;
      if (conns.has(id)) continue;

      conns.set(id, {
        id,
        path,
        // remoteAddr is deprecated upstream; keep it optional like the forward_dests
        // shape (an idle/tearing-down conn could shed the label).
        remoteAddr: labels["remoteAddr"] ? labels["remoteAddr"]! : null,
        state,
      });
    }

    return [...conns.values()];
  }

  private buildPublishMap(conns: RtmpConn[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const conn of conns) {
      // Only publish (inbound) connections identify a stream source; read conns describe
      // consumers and must not classify a socket as INBOUND. Loopback remotes are internal
      // relays (their publisher socket belongs to another local process) and are classified
      // by StreamMonitor's own inbound branch, never by correlation.
      if (conn.state === "publish" && conn.remoteAddr && !isLoopbackRemote(conn.remoteAddr)) {
        map.set(conn.remoteAddr, conn.path);
      }
    }
    return map;
  }

  // A republish mints a fresh publish-connection id on the same path while the
  // path itself never leaves /metrics, so neither eviction notices. The new
  // session gets a new availableTime: drop the cached details so the next
  // ensurePaths refetches instead of serving the previous session's.
  private trackPublishConnections(raw: RawSrtMetric[], rtmpConns: RtmpConn[]): void {
    const seen = new Set<string>();
    const publishers: Array<{ path: string; id: string }> = [];
    for (const conn of raw) {
      if (conn.state === "publish") publishers.push(conn);
    }
    for (const conn of rtmpConns) {
      if (conn.state === "publish") publishers.push(conn);
    }
    for (const { path, id } of publishers) {
      seen.add(path);
      if (this.pathPublishConn.get(path) !== id) {
        this.pathPublishConn.set(path, id);
        this.pathCache.delete(path);
        this.readersCache.delete(path);
        this.startedAtCache.delete(path);
      }
    }
    for (const path of [...this.pathPublishConn.keys()]) {
      if (!seen.has(path)) this.pathPublishConn.delete(path);
    }
  }

  // Drop per-path details for paths gone from /metrics so a returning path
  // refetches fresh tracks and a fresh availableTime. Names cached empty (unknown
  // paths, failed fetches) are left alone: evicting them would bypass the
  // refetch throttle and churn a GET every tick.
  private evictDeadPaths(active: Set<string>): void {
    for (const name of [...this.pathCache.keys()]) {
      if (active.has(name)) continue;
      if (
        this.pathCache.get(name)!.length === 0 &&
        !this.readersCache.has(name) &&
        !this.startedAtCache.has(name)
      ) {
        continue;
      }
      this.pathCache.delete(name);
      this.readersCache.delete(name);
      this.startedAtCache.delete(name);
    }
  }

  private async ensurePath(name: string): Promise<void> {
    const cached = this.pathCache.get(name);
    // A name cached with tracks never refetches on its own; a name cached empty
    // refetches only when the throttle window is open (self-heal for the first
    // fetch racing the publisher). Failures cache empty and retry next window.
    if (cached !== undefined && (cached.length > 0 || !this.emptyRefetchOpen())) return;

    // Coalesce concurrent callers onto the in-flight fetch.
    const inflight = this.pendingPath.get(name);
    if (inflight) {
      await inflight;
      return;
    }

    const task = this.fetchPath(name);
    this.pendingPath.set(name, task);
    try {
      await task;
    } finally {
      this.pendingPath.delete(name);
    }
  }

  private emptyRefetchOpen(): boolean {
    return this.now() - this.lastFetchAt >= this.emptyRefetchIntervalMs;
  }

  private async fetchPath(name: string): Promise<void> {
    // Stamp at the start so the throttle counts from the last fetch attempt (success or
    // failure): a down mediamtx retries after the window instead of every tick, and a
    // successful pull resets the clock for the next empty-refetch pass.
    this.lastFetchAt = this.now();
    const result = await this.resolvePath(name);
    if (!result.ok) {
      this.pathCache.set(name, []);
      return;
    }

    let parsed: PathGetResponse;
    try {
      parsed = JSON.parse(result.text) as PathGetResponse;
    } catch {
      this.pathCache.set(name, []);
      return;
    }

    const tracks: Track[] = [];
    for (const raw of parsed.tracks2 ?? []) {
      if (!raw || !raw.codec) continue;
      tracks.push({ codec: raw.codec, codecProps: raw.codecProps });
    }
    this.pathCache.set(name, tracks);
    if (Array.isArray(parsed.readers)) {
      this.readersCache.set(name, parsed.readers.length);
    } else {
      this.readersCache.delete(name);
    }
    const startedAt = MediamtxCollector.parseTime(parsed.availableTime ?? parsed.readyTime);
    if (startedAt !== null) {
      this.startedAtCache.set(name, startedAt);
    } else {
      this.startedAtCache.delete(name);
    }
  }

  private async resolvePath(name: string): Promise<FetchResult> {
    if (this.pathFetcher) return this.pathFetcher(name);
    if (this.useMockData) {
      const text = this.mockPaths[name];
      return text === undefined ? { ok: false, text: "" } : { ok: true, text };
    }
    try {
      const response = await fetch(`${this.controlBase}/v3/paths/get/${encodeURIComponent(name)}`);
      if (!response.ok) return { ok: false, text: "" };
      return { ok: true, text: await response.text() };
    } catch {
      return { ok: false, text: "" };
    }
  }

  private async getMetricsResult(): Promise<CommandExecutionResult> {
    if (this.useMockData && this.mockOutputs.length > 0) {
      const mockOutput = this.getNextMockOutput();
      this.pendingMockElapsedMs = mockOutput.elapsedMs ?? null;

      return {
        success: true,
        stdout: mockOutput.stdout,
        stderr: "",
      };
    }

    this.pendingMockElapsedMs = null;
    return this.metricsFetcher();
  }

  // Connection ids are per-connection UUIDs, never reused: windows of vanished
  // connections would otherwise accumulate forever. Live entries are untouched, so
  // per-tick health, jitter and counter-reset detection behave exactly as before.
  private evictDeadConnections(liveIds: string[]): void {
    const live = new Set(liveIds);
    for (const cache of [this.states, this.throughputSamples, this.rttSamples]) {
      for (const id of cache.keys()) {
        if (!live.has(id)) cache.delete(id);
      }
    }
  }

  private getNextMockOutput(): MockOutput {
    const item = this.mockOutputs[this.mockIndex] ?? this.mockOutputs[0] ?? "";

    if (this.mockOutputs.length > 0) {
      this.mockIndex = (this.mockIndex + 1) % this.mockOutputs.length;
    }

    return typeof item === "string" ? { stdout: item } : item;
  }

  private calculateHealth(raw: RawSrtMetric, srtlaPaths: Set<string>): SrtMetrics {
    const stateKey = raw.id;
    const prevState = this.states.get(raw.id);
    const wallClockNow = this.now();
    const sampleTimestamp =
      prevState && this.pendingMockElapsedMs !== null ? prevState.timestamp + this.pendingMockElapsedMs : wallClockNow;

    const rtt = raw.metrics["srt_conns_ms_rtt"] || 0;
    const link_capacity_bps = Math.max(0, Math.round((raw.metrics["srt_conns_mbps_link_capacity"] || 0) * 1_000_000));
    const bytes_sent = raw.metrics["srt_conns_bytes_sent"] || 0;
    const bytes_received = raw.metrics["srt_conns_bytes_received"] || 0;
    const send_q = raw.metrics["srt_conns_bytes_send_buf"] || 0;
    const recv_q = raw.metrics["srt_conns_bytes_receive_buf"] || 0;
    const send_buffer_ms = raw.metrics["srt_conns_ms_send_buf"] || 0;
    const recv_buffer_ms = raw.metrics["srt_conns_ms_receive_buf"] || 0;
    const tsbpdDelayMs = Math.max(
      raw.metrics["srt_conns_ms_send_tsb_pd_delay"] || 0,
      raw.metrics["srt_conns_ms_receive_tsb_pd_delay"] || 0,
    );
    const flight_size = raw.metrics["srt_conns_packets_flight_size"] || 0;
    const flow_window = raw.metrics["srt_conns_packets_flow_window"] || 0;
    const packets_retrans = raw.metrics["srt_conns_packets_retrans"] || 0;
    const packets_received_retrans = raw.metrics["srt_conns_packets_received_retrans"] || 0;
    const retrans_total = packets_retrans + packets_received_retrans;
    const isPublish = raw.state === "publish";
    const drop_percent = Number(
      (isPublish
        ? raw.metrics["srt_conns_packets_received_loss_rate"] || 0
        : raw.metrics["srt_conns_packets_send_loss_rate"] || 0
      ).toFixed(2),
    );

    let health = 100;
    const isFirstTick = !prevState;

    const currentPackets = isPublish
      ? raw.metrics["srt_conns_packets_received"] || 0
      : raw.metrics["srt_conns_packets_sent"] || 0;
    const currentDrops = isPublish
      ? raw.metrics["srt_conns_packets_received_drop"] || 0
      : raw.metrics["srt_conns_packets_send_drop"] || 0;
    const currentRetrans = isPublish ? packets_received_retrans : packets_retrans;

    const previousSamples = this.throughputSamples.get(stateKey) ?? [];
    const lastSample = previousSamples[previousSamples.length - 1];
    const countersReset =
      !!lastSample && (bytes_sent < lastSample.bytes_sent || bytes_received < lastSample.bytes_received);

    const nextSamples = countersReset
      ? [{ bytes_sent, bytes_received, timestamp: sampleTimestamp }]
      : [...previousSamples, { bytes_sent, bytes_received, timestamp: sampleTimestamp }].slice(
          -MediamtxCollector.RATE_WINDOW_SAMPLE_COUNT,
        );

    this.throughputSamples.set(stateKey, nextSamples);

    const tx_bps = Math.max(0, Math.round((raw.metrics["srt_conns_mbps_send_rate"] || 0) * 1_000_000));
    const rx_bps = Math.max(0, Math.round((raw.metrics["srt_conns_mbps_receive_rate"] || 0) * 1_000_000));

    const previousRttSamples = this.rttSamples.get(stateKey) ?? [];
    const nextRttSamples = [...previousRttSamples, { rtt, timestamp: sampleTimestamp }].slice(
      -MediamtxCollector.RTT_WINDOW_SAMPLE_COUNT,
    );
    this.rttSamples.set(stateKey, nextRttSamples);

    const rtt_jitter = MediamtxCollector.calculateRttJitter(nextRttSamples);

    if (prevState) {
      const packetDelta = Math.max(
        0,
        currentPackets - (isPublish ? prevState.packets_received : prevState.packets_sent),
      );
      const dropDelta = Math.max(
        0,
        currentDrops - (isPublish ? prevState.packets_received_drop : prevState.packets_send_drop),
      );
      const retransDelta = Math.max(
        0,
        currentRetrans - (isPublish ? prevState.packets_received_retrans : prevState.packets_retrans),
      );

      const dropRatePenalty = packetDelta > 0 ? Math.min(10, (dropDelta / packetDelta) * 150) : 0;
      const lossRatePenalty = Math.min(10, drop_percent * 0.5);
      const retransPenalty = packetDelta > 0 ? Math.min(15, (retransDelta / packetDelta) * 200) : 0;
      const rttPenalty = Math.min(10, Math.max(0, (rtt - 150) / 30));
      const rttJitterPenalty = Math.min(25, Math.max(0, (rtt_jitter - 20) / 4));
      const queueDelayMs = isPublish ? Math.max(0, recv_buffer_ms - tsbpdDelayMs) : send_buffer_ms;
      const bufferPenalty = Math.min(20, Math.max(0, queueDelayMs - 150) / 40);
      const queueBytesPenalty = isPublish ? 0 : Math.min(8, Math.max(0, send_q - 256_000) / 128_000);
      const flightPenalty =
        !isPublish && flow_window > 0 ? Math.min(8, Math.max(0, (flight_size / flow_window - 0.85) * 35)) : 0;

      health -=
        dropRatePenalty +
        lossRatePenalty +
        retransPenalty +
        rttPenalty +
        rttJitterPenalty +
        bufferPenalty +
        queueBytesPenalty +
        flightPenalty;
    } else {
      const firstTickBufferPenalty = isPublish
        ? Math.min(4, Math.max(0, recv_buffer_ms - tsbpdDelayMs - 250) / 150)
        : Math.min(4, Math.max(0, send_buffer_ms - 250) / 80);
      health -= firstTickBufferPenalty;
    }

    health = Math.max(0, Math.min(100, Math.round(health)));

    this.states.set(raw.id, {
      packets_received_drop: raw.metrics["srt_conns_packets_received_drop"] || 0,
      packets_send_drop: raw.metrics["srt_conns_packets_send_drop"] || 0,
      packets_received: raw.metrics["srt_conns_packets_received"] || 0,
      packets_sent: raw.metrics["srt_conns_packets_sent"] || 0,
      packets_retrans,
      packets_received_retrans,
      tx_bps,
      rx_bps,
      timestamp: sampleTimestamp,
    });

    // SRTLA is an inbound-only variant of SRT: mediamtx wraps a publisher's SRTLA bond as a
    // regular SRT publish connection whose path matches an SRTLA group. Outbound (read) SRT
    // connections never belong to an SRTLA group, so only mark inbound ones as SRTLA.
    const isSrtla = isPublish && srtlaPaths.has(raw.path);

    return {
      protocol: isSrtla ? "SRTLA" : "SRT",
      target: isPublish ? "INBOUND" : "OUTBOUND",
      stream_id: raw.path,
      peer_ip: raw.remoteAddr,
      mode: raw.state,
      rtt,
      rtt_jitter,
      tx_bps,
      rx_bps,
      link_capacity_bps,
      bytes_sent,
      bytes_received,
      drop_percent,
      recv_q,
      send_q,
      recv_buffer_ms,
      send_buffer_ms,
      tsbpd_delay_ms: tsbpdDelayMs,
      retrans_total,
      flight_size,
      flow_window,
      health,
      is_first_tick: isFirstTick,
    };
  }

  private static calculateRttJitter(samples: RttSample[]): number {
    if (samples.length < 2) {
      return 0;
    }

    let totalDelta = 0;

    for (let index = 1; index < samples.length; index += 1) {
      totalDelta += Math.abs(samples[index]!.rtt - samples[index - 1]!.rtt);
    }

    return Number((totalDelta / (samples.length - 1)).toFixed(1));
  }

  private static async fetchMetrics(): Promise<CommandExecutionResult> {
    try {
      const response = await fetch("http://localhost:9998/metrics");
      if (!response.ok) {
        return {
          success: false,
          stdout: "",
          stderr: "",
          error: `HTTP error! status: ${response.status}`,
        };
      }

      const stdout = await response.text();
      return {
        success: true,
        stdout,
        stderr: "",
      };
    } catch (error) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
