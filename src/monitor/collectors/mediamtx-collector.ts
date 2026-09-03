import { isLoopbackRemote } from "../net-addr";
import { PathInfoService, type PathInfoServiceOptions } from "../path-info-service";
import type { Track } from "../../core/types";

export type PathInfoOptions = PathInfoServiceOptions;

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
  remoteAddr: string;
  state: string;
  metrics: Record<string, number>;
}

interface ForwardDest {
  id: string;
  path: string;
  protocol: string;
  remoteAddr: string | null;
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
// forward destinations, RTMP publisher correlation) plus cached /v3/paths/list track
// metadata. Stateless across ticks except for the rolling health windows. Grouping,
// events and snapshots stay in the grouping layer.
export class MediamtxCollector {
  private static readonly RATE_WINDOW_SAMPLE_COUNT = 4;
  private static readonly RTT_WINDOW_SAMPLE_COUNT = 6;
  private readonly states = new Map<string, SrtPreviousState>();
  private readonly throughputSamples = new Map<string, ThroughputSample[]>();
  private readonly rttSamples = new Map<string, RttSample[]>();
  private mockIndex = 0;
  private pendingMockElapsedMs: number | null = null;

  private readonly metricsFetcher: () => Promise<CommandExecutionResult>;
  private readonly now: () => number;
  private readonly useMockData: boolean;
  private readonly mockOutputs: Array<string | MockOutput>;
  private readonly pathInfo: PathInfoService;

  public constructor(options: MediamtxCollectorOptions = {}) {
    this.metricsFetcher = options.metricsFetcher ?? MediamtxCollector.fetchMetrics;
    this.now = options.now ?? Date.now;
    this.useMockData = options.useMockData ?? false;
    this.mockOutputs = options.mockOutputs ?? [];
    this.pathInfo = new PathInfoService({
      ...options.pathInfo,
      now: options.pathInfo?.now ?? options.now,
    });
  }

  public ensurePaths(paths: Iterable<string>): Promise<void> {
    return this.pathInfo.ensurePaths(paths);
  }

  public getTracks(path: string): Track[] | undefined {
    return this.pathInfo.getTracks(path);
  }

  public getReaders(path: string): number | undefined {
    return this.pathInfo.getReaders(path);
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
      const srtlaPaths = this.parseSrtlaPaths(commandResult.stdout);
      const metrics = rawData.map((raw) => this.calculateHealth(raw, srtlaPaths));
      const forwardMap = this.buildForwardMap(this.parseForwardDestinations(commandResult.stdout));
      const publishMap = this.buildPublishMap(this.parseRtmpConnections(commandResult.stdout));

      return { success: true, metrics, forwardMap, publishMap };
    } catch (error) {
      return {
        success: false,
        error: `Failed to parse SRT metrics: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
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
      const match = line.match(
        /^(srt_conns[a-z_]*)\{id="([^"]+)",path="([^"]+)",remoteAddr="([^"]+)",state="([^"]+)"\}\s+([0-9.\-e+]+)/,
      );

      if (!match) {
        continue;
      }

      const metricName = match[1]!;
      const id = match[2]!;
      const path = match[3]!;
      const remoteAddr = match[4]!;
      const state = match[5]!;
      const value = parseFloat(match[6]!);

      if (!connections.has(id)) {
        connections.set(id, {
          id,
          path,
          remoteAddr,
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
      // `forward_dests_outbound_bytes{...}`. remoteAddr is only emitted while the forward
      // is actually forwarding, so it may be absent (state="idle").
      const match = line.match(
        /^forward_dests\{id="([^"]+)",path="([^"]+)",protocol="([^"]+)"(?:,remoteAddr="([^"]+)")?,state="([^"]+)"\}\s+\d+/,
      );
      if (!match) continue;

      const id = match[1]!;
      if (dests.has(id)) continue;

      dests.set(id, {
        id,
        path: match[2]!,
        protocol: match[3]!,
        remoteAddr: match[4] ? match[4] : null,
        state: match[5]!,
      });
    }

    return [...dests.values()];
  }

  private buildForwardMap(dests: ForwardDest[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const dest of dests) {
      // Only actively-forwarding destinations expose a real remoteAddr; idle ones either lack
      // the label (no live socket yet) or hold it with state="idle", and must not correlate.
      if (dest.state !== "idle" && dest.remoteAddr) {
        map.set(dest.remoteAddr, dest.path);
      }
    }
    return map;
  }

  // Parse the rtmp_conns metrics section into per-connection identity records. Like the SRT
  // parser above, only base `rtmp_conns{...}` lines carry the label set; derivatives such as
  // `rtmp_conns_inbound_bytes{...}` are skipped by pinning the prefix to `rtmp_conns{`.
  public parseRtmpConnections(output: string): RtmpConn[] {
    const conns = new Map<string, RtmpConn>();

    for (const line of output.split("\n")) {
      // remoteAddr is always present on live connections but keep it optional to mirror the
      // forward_dests shape (an idle/tearing-down conn could shed the label).
      const match = line.match(
        /^rtmp_conns\{id="([^"]+)",path="([^"]+)"(?:,remoteAddr="([^"]*)")?,state="([^"]+)"\}\s+\d+/,
      );
      if (!match) continue;

      const id = match[1]!;
      if (conns.has(id)) continue;

      conns.set(id, {
        id,
        path: match[2]!,
        remoteAddr: match[3] ? match[3] : null,
        state: match[4]!,
      });
    }

    return [...conns.values()];
  }

  private buildPublishMap(conns: RtmpConn[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const conn of conns) {
      // Only publish (inbound) connections identify a stream source; read conns describe
      // consumers and must not classify a socket as INBOUND. Loopback remotes are internal
      // relays (e.g. nginx fronting mediamtx): their publisher socket belongs to another
      // process and is classified by StreamMonitor's own inbound branch, never by correlation.
      if (conn.state === "publish" && conn.remoteAddr && !isLoopbackRemote(conn.remoteAddr)) {
        map.set(conn.remoteAddr, conn.path);
      }
    }
    return map;
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
