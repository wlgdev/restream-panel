import { StreamEventLog } from "./streamEventLog";

export interface SrtMetrics {
  protocol: "SRT";
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

export interface LogicalSrtStream {
  id: string;
  startedAt: number;
  inbound: SrtMetrics | null;
  outbound: SrtMetrics[];
}

export interface SrtSnapshot {
  success: boolean;
  data: SrtMetrics[];
  streams: LogicalSrtStream[];
  timestamp: string;
  error?: string;
}

interface RawSrtMetric {
  id: string;
  path: string;
  remoteAddr: string;
  state: string;
  metrics: Record<string, number>;
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

interface ActiveSrtStreamState {
  startedAt: number;
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

interface SrtMonitorOptions {
  metricsFetcher?: () => Promise<CommandExecutionResult>;
  now?: () => number;
  useMockData?: boolean;
  mockOutputs?: Array<string | MockOutput>;
  intervalMs?: number;
  clientTtlMs?: number;
  eventLog?: StreamEventLog;
}

export class SrtMonitor {
  private static readonly RATE_WINDOW_SAMPLE_COUNT = 4;
  private static readonly RTT_WINDOW_SAMPLE_COUNT = 6;
  private readonly states = new Map<string, SrtPreviousState>();
  private readonly throughputSamples = new Map<string, ThroughputSample[]>();
  private readonly rttSamples = new Map<string, RttSample[]>();
  private readonly activeClients = new Map<string, number>();
  private mockIndex = 0;
  private pendingMockElapsedMs: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundPolling = false;
  private lastSnapshot: SrtSnapshot = {
    success: true,
    data: [],
    streams: [],
    timestamp: new Date(0).toISOString(),
  };

  private readonly activeStreams = new Map<string, ActiveSrtStreamState>();
  private readonly lastKnownConnections = new Map<string, { target: string; peerIp: string | null }>();

  private readonly metricsFetcher: () => Promise<CommandExecutionResult>;
  private readonly now: () => number;
  private readonly useMockData: boolean;
  private readonly mockOutputs: Array<string | MockOutput>;
  private readonly intervalMs: number;
  private readonly clientTtlMs: number;
  private readonly eventLog?: StreamEventLog;

  public constructor(options: SrtMonitorOptions = {}) {
    this.metricsFetcher = options.metricsFetcher ?? SrtMonitor.fetchMetrics;
    this.now = options.now ?? Date.now;
    this.useMockData = options.useMockData ?? false;
    this.mockOutputs = options.mockOutputs ?? [];
    this.intervalMs = options.intervalMs ?? 5000;
    this.clientTtlMs = options.clientTtlMs ?? 15000;
    this.eventLog = options.eventLog;
  }

  public parse(output: string): RawSrtMetric[] {
    const lines = output.split("\n");
    const connections = new Map<string, RawSrtMetric>();

    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;

      const match = line.match(
        /^([a-z_]+)\{id="([^"]+)",path="([^"]+)",remoteAddr="([^"]+)",state="([^"]+)"\}\s+([0-9.\-e+]+)/,
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

  public async touchClient(clientId: string): Promise<void> {
    this.activeClients.set(clientId, this.now());

    if (!this.pollTimer) {
      await this.collectOnce();
      this.startPolling();
    }
  }

  public disconnectClient(clientId: string) {
    this.activeClients.delete(clientId);
    this.stopPollingIfIdle();
  }

  public startBackgroundPolling(): void {
    this.backgroundPolling = true;
    if (!this.pollTimer) {
      void this.collectOnce();
      this.startPolling();
    }
  }

  public async collectOnce(): Promise<SrtSnapshot> {
    const commandResult = await this.getMetricsResult();
    const timestamp = new Date().toISOString();

    if (!commandResult.success) {
      this.lastSnapshot = {
        success: false,
        data: [],
        streams: [],
        timestamp,
        error: commandResult.error ?? commandResult.stderr ?? "Failed to fetch SRT metrics",
      };
      return this.lastSnapshot;
    }

    try {
      const rawData = this.parse(commandResult.stdout);
      const data = rawData.map((raw) => this.calculateHealth(raw));
      this.syncActiveStreams(data);
      const streams = this.buildLogicalStreams(data);

      this.lastSnapshot = {
        success: true,
        data,
        streams,
        timestamp,
      };
      return this.lastSnapshot;
    } catch (error) {
      this.lastSnapshot = {
        success: false,
        data: [],
        streams: [],
        timestamp,
        error: `Failed to parse SRT metrics: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
      return this.lastSnapshot;
    }
  }

  public getSnapshot(): SrtSnapshot {
    return this.lastSnapshot;
  }

  public stopAll() {
    this.activeClients.clear();
    this.backgroundPolling = false;
    if (!this.pollTimer) {
      return;
    }

    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private startPolling() {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.runPollingTick();
    }, this.intervalMs);
  }

  private async runPollingTick() {
    this.pruneInactiveClients();
    if (!this.backgroundPolling && this.activeClients.size === 0) {
      this.stopAll();
      return;
    }

    await this.collectOnce();
  }

  private pruneInactiveClients() {
    const now = this.now();

    for (const [clientId, lastSeenAt] of this.activeClients) {
      if (now - lastSeenAt > this.clientTtlMs) {
        this.activeClients.delete(clientId);
      }
    }
  }

  private stopPollingIfIdle() {
    if (this.backgroundPolling) return;
    this.pruneInactiveClients();
    if (this.activeClients.size > 0 || !this.pollTimer) {
      return;
    }

    clearInterval(this.pollTimer);
    this.pollTimer = null;
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

  private syncActiveStreams(metrics: SrtMetrics[]): void {
    const now = this.now();
    const currentStreamIds = new Set<string>();

    for (const metric of metrics) {
      if (!metric.stream_id) continue;
      currentStreamIds.add(metric.stream_id);

      if (!this.activeStreams.has(metric.stream_id)) {
        this.activeStreams.set(metric.stream_id, { startedAt: now });
        if (this.eventLog) {
          this.eventLog.push({
            timestamp: new Date(now).toISOString(),
            type: metric.target === "INBOUND" ? "stream_start" : "target_connected",
            protocol: "SRT",
            streamId: metric.stream_id,
            target: metric.target,
            peerIp: metric.peer_ip,
          });
        }
      }
      this.lastKnownConnections.set(metric.stream_id, {
        target: metric.target,
        peerIp: metric.peer_ip,
      });
    }

    for (const [streamId] of this.activeStreams) {
      if (!currentStreamIds.has(streamId)) {
        this.activeStreams.delete(streamId);
        const lastKnown = this.lastKnownConnections.get(streamId);
        if (this.eventLog && lastKnown) {
          this.eventLog.push({
            timestamp: new Date(now).toISOString(),
            type: lastKnown.target === "INBOUND" ? "stream_end" : "target_disconnected",
            protocol: "SRT",
            streamId,
            target: lastKnown.target,
            peerIp: lastKnown.peerIp,
          });
        }
        this.lastKnownConnections.delete(streamId);
      }
    }
  }

  private calculateHealth(raw: RawSrtMetric): SrtMetrics {
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
          -SrtMonitor.RATE_WINDOW_SAMPLE_COUNT,
        );

    this.throughputSamples.set(stateKey, nextSamples);

    const tx_bps = Math.max(0, Math.round((raw.metrics["srt_conns_mbps_send_rate"] || 0) * 1_000_000));
    const rx_bps = Math.max(0, Math.round((raw.metrics["srt_conns_mbps_receive_rate"] || 0) * 1_000_000));

    // if (nextSamples.length >= 2) {
    //   const firstSample = nextSamples[0]!;
    //   const latestSample = nextSamples[nextSamples.length - 1]!;
    //   const windowSeconds = (latestSample.timestamp - firstSample.timestamp) / 1000;
    //   const sentDelta = latestSample.bytes_sent - firstSample.bytes_sent;
    // }

    const previousRttSamples = this.rttSamples.get(stateKey) ?? [];
    const nextRttSamples = [...previousRttSamples, { rtt, timestamp: sampleTimestamp }].slice(
      -SrtMonitor.RTT_WINDOW_SAMPLE_COUNT,
    );
    this.rttSamples.set(stateKey, nextRttSamples);

    const rtt_jitter = SrtMonitor.calculateRttJitter(nextRttSamples);

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

    return {
      protocol: "SRT",
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

  private buildLogicalStreams(metrics: SrtMetrics[]): LogicalSrtStream[] {
    const streamMap = new Map<string, LogicalSrtStream>();

    for (const metric of metrics) {
      if (!metric.stream_id) continue;

      if (!streamMap.has(metric.stream_id)) {
        const state = this.activeStreams.get(metric.stream_id);
        streamMap.set(metric.stream_id, {
          id: metric.stream_id,
          startedAt: state?.startedAt ?? this.now(),
          inbound: null,
          outbound: [],
        });
      }

      const stream = streamMap.get(metric.stream_id)!;
      if (metric.target === "INBOUND") {
        stream.inbound = metric;
      } else {
        stream.outbound.push(metric);
      }
    }

    return [...streamMap.values()];
  }

  private static async fetchMetrics(): Promise<CommandExecutionResult> {
    try {
      const response = await fetch("http://localhost:9998/metrics?type=srt_conns");
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
