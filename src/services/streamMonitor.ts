import * as fs from "node:fs";
import { RtmpTargetResolver, type ResolvedRtmpTarget } from "./rtmpTargetResolver";
import { RTMP_MONITOR_INBOUND_PORTS } from "../core/constants";
import { StreamEventLog } from "./streamEventLog";

export interface StreamMetrics {
  target: string;
  stream_id?: string;
  pid: number | null;
  local_ip: string | null;
  peer_ip: string | null;

  recv_q: number;
  send_q: number;

  rtt: number;

  tx_bps: number;
  tx_kernel_bps: number;
  rx_bps: number;

  bytes_sent: number;
  bytes_received: number;
  bytes_retrans: number;
  data_segs_out: number;
  mss: number;
  notsent: number;

  unacked: number;
  retrans_current: number;
  retrans_total: number;

  health: number;
  drop_percent: number;
  is_first_tick: boolean;
}

export interface LogicalStream {
  id: string;
  startedAt: number;
  inbound: StreamMetrics | null;
  outbound: StreamMetrics[];
}

export interface StreamSnapshot {
  success: boolean;
  data: StreamMetrics[];
  streams: LogicalStream[];
  timestamp: string;
  error?: string;
}

interface PreviousState {
  bytes_sent: number;
  bytes_retrans: number;
  bytes_received: number;
  retrans_total: number;
  data_segs_out: number;
  tx_bps: number;
  rx_bps: number;
  timestamp: number;
}

interface ThroughputSample {
  bytes_sent: number;
  bytes_received: number;
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

interface StreamMonitorOptions {
  commandExecutor?: () => CommandExecutionResult;
  now?: () => number;
  useMockData?: boolean;
  mockOutputs?: Array<string | MockOutput>;
  random?: () => number;
  intervalMs?: number;
  clientTtlMs?: number;
  rtmpTargetResolver?: Pick<RtmpTargetResolver, "resolveTarget">;
  eventLog?: StreamEventLog;
}

interface ActiveStreamState {
  startedAt: number;
  inboundKey: string;
  loggedStart?: boolean;
}

export class StreamMonitor {
  private static readonly RATE_WINDOW_SAMPLE_COUNT = 4;
  private static readonly ASSOCIATION_WINDOW_MS = 10_000;
  private readonly processStreamIdCache = new Map<number, string | null>();
  private readonly states = new Map<string, PreviousState>();
  private readonly throughputSamples = new Map<string, ThroughputSample[]>();
  private readonly activeClients = new Map<string, number>();
  private mockIndex = 0;
  private pendingMockElapsedMs: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundPolling = false;
  private lastSnapshot: StreamSnapshot = {
    success: true,
    data: [],
    streams: [],
    timestamp: new Date(0).toISOString(),
  };

  private readonly firstSeen = new Map<string, number>();
  private readonly connectionToStream = new Map<string, string>();
  private readonly activeStreams = new Map<string, ActiveStreamState>();
  private streamCounter = 0;

  private readonly commandExecutor: () => CommandExecutionResult;
  private readonly now: () => number;
  private readonly useMockData: boolean;
  private readonly mockOutputs: Array<string | MockOutput>;
  private readonly random: () => number;
  private readonly intervalMs: number;
  private readonly clientTtlMs: number;
  private readonly rtmpTargetResolver: Pick<RtmpTargetResolver, "resolveTarget">;
  private readonly eventLog: StreamEventLog;
  private readonly lastKnownConnections = new Map<string, { target: string; streamId: string; peerIp: string | null; loggedStart?: boolean }>();

  public constructor(options: StreamMonitorOptions = {}) {
    this.commandExecutor = options.commandExecutor ?? StreamMonitor.executeSsCommand;
    this.now = options.now ?? Date.now;
    this.useMockData = options.useMockData ?? false;
    this.mockOutputs = options.mockOutputs ?? [];
    this.random = options.random ?? Math.random;
    this.intervalMs = options.intervalMs ?? 5000;
    this.clientTtlMs = options.clientTtlMs ?? 15000;
    this.rtmpTargetResolver = options.rtmpTargetResolver ?? new RtmpTargetResolver();
    this.eventLog = options.eventLog ?? new StreamEventLog();
  }

  public getEventsSince(since?: number) {
    return this.eventLog.getSince(since);
  }

  public parse(ssOutput: string): StreamMetrics[] {
    const lines = ssOutput.split("\n");
    const results: StreamMetrics[] = [];
    let currentTarget: Partial<StreamMetrics> | null = null;
    const activePids = new Set<number>();

    for (const line of lines) {
      if (line.startsWith("State")) continue;

      if (line.startsWith("ESTAB")) {
        currentTarget = null;

        const parts = line.trim().split(/\s+/);
        const recvQ = parseInt(parts[1] ?? "0", 10);
        const sendQ = parseInt(parts[2] ?? "0", 10);
        const localAddress = parts[3] ?? "";
        const peerAddress = parts[4] ?? "";

        let targetName = "";

        if (peerAddress.endsWith(":443") && line.includes("stunnel4")) {
          targetName = "TWITCH";
        } else if (
          line.includes("ffmpeg") &&
          !peerAddress.startsWith("127.0.0.1")
        ) {
          targetName = "UNKNOWN";
        } else if (
          StreamMonitor.isMonitoredInboundAddress(peerAddress) &&
          line.includes("nginx") &&
          !peerAddress.startsWith("127.0.0.1")
        ) {
          targetName = "UNKNOWN";
        } else if (
          StreamMonitor.isMonitoredInboundAddress(localAddress) &&
          line.includes("nginx") &&
          !localAddress.startsWith("127.0.0.1")
        ) {
          targetName = "INBOUND";
        }

        if (targetName) {
          const pidMatch = line.match(/pid=(\d+)/);
          if (!pidMatch || !pidMatch[1]) continue;

          const pid = parseInt(pidMatch[1], 10);
          activePids.add(pid);

          currentTarget = {
            target: targetName,
            recv_q: recvQ,
            send_q: sendQ,
            local_ip: localAddress,
            peer_ip: peerAddress,
            pid,
            stream_id: line.includes("ffmpeg") ? (this.getFfmpegStreamId(pid) ?? undefined) : undefined,
          };
        }

        continue;
      }

      if (currentTarget && /^\s+/.test(line)) {
        currentTarget.tx_kernel_bps = parseInt(line.match(/send\s+(\d+)bps/)?.[1] || "0", 10);
        currentTarget.bytes_sent = parseInt(line.match(/bytes_sent:(\d+)/)?.[1] || "0", 10);
        currentTarget.bytes_received = parseInt(line.match(/bytes_received:(\d+)/)?.[1] || "0", 10);
        currentTarget.bytes_retrans = parseInt(line.match(/bytes_retrans:(\d+)/)?.[1] || "0", 10);
        currentTarget.data_segs_out = parseInt(line.match(/data_segs_out:(\d+)/)?.[1] || "0", 10);
        currentTarget.mss = parseInt(line.match(/mss:(\d+)/)?.[1] || "0", 10);
        currentTarget.notsent = parseInt(line.match(/notsent:(\d+)/)?.[1] || "0", 10);
        currentTarget.rtt = parseFloat(line.match(/rtt:([\d.]+)/)?.[1] || "0");
        currentTarget.unacked = parseInt(line.match(/unacked:(\d+)/)?.[1] || "0", 10);

        const retransMatch = line.match(/retrans:(\d+)\/(\d+)/);
        currentTarget.retrans_current = parseInt(retransMatch?.[1] || "0", 10);
        currentTarget.retrans_total = parseInt(retransMatch?.[2] || "0", 10);

        if (currentTarget.bytes_sent !== undefined || currentTarget.bytes_received !== undefined) {
          this.calculateHealthAndSpeed(currentTarget as StreamMetrics);
          results.push(currentTarget as StreamMetrics);
        }

        currentTarget = null;
      }
    }

    for (const cachedPid of this.processStreamIdCache.keys()) {
      if (!activePids.has(cachedPid)) {
        this.processStreamIdCache.delete(cachedPid);
      }
    }

    return results;
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

  public async collectOnce(): Promise<StreamSnapshot> {
    const commandResult = this.getCommandResult();
    const timestamp = new Date().toISOString();

    if (!commandResult.success) {
      this.lastSnapshot = {
        success: false,
        data: [],
        streams: [],
        timestamp,
        error: commandResult.error ?? commandResult.stderr ?? "Failed to run ss -itnop",
      };
      return this.lastSnapshot;
    }

    try {
      const data = this.parse(commandResult.stdout);
      await this.resolveRtmpTargets(data);
      this.assignStreams(data);
      const streams = this.buildLogicalStreams(data);

      for (const metric of data) {
        if (metric.target !== "INBOUND" && metric.stream_id && metric.health < 90 && !metric.is_first_tick) {
          this.eventLog.push({
            timestamp: timestamp,
            type: "quality_degraded",
            protocol: "RTMP",
            streamId: metric.stream_id,
            target: metric.target,
            peerIp: metric.peer_ip,
            metrics: {
              health: metric.health,
              tx_bps: metric.tx_bps,
              rx_bps: metric.rx_bps,
              bytes_sent: metric.bytes_sent,
              bytes_received: metric.bytes_received,
              rtt: metric.rtt,
              send_q: metric.send_q,
              recv_q: metric.recv_q,
              drop_percent: metric.drop_percent,
              retrans_total: metric.retrans_total,
            },
          });
        }
      }

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
        error: `Failed to parse ss output: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
      return this.lastSnapshot;
    }
  }

  public getSnapshot(): StreamSnapshot {
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

  private getCommandResult(): CommandExecutionResult {
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
    return this.commandExecutor();
  }

  private getNextMockOutput(): MockOutput {
    const item = this.mockOutputs[this.mockIndex] ?? this.mockOutputs[0] ?? "";

    if (this.mockOutputs.length > 0) {
      this.mockIndex = (this.mockIndex + 1) % this.mockOutputs.length;
    }

    if (typeof item === "string") {
      return { stdout: item };
    }

    return item;
  }

  private getFfmpegStreamId(pid: number): string | null {
    if (this.processStreamIdCache.has(pid)) {
      return this.processStreamIdCache.get(pid) ?? null;
    }

    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const match = cmdline.match(/rtmp:\/\/(?:127\.0\.0\.1|localhost):\d+\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        this.processStreamIdCache.set(pid, match[1]);
        return match[1];
      }
    } catch {
      // Ignore errors
    }

    this.processStreamIdCache.set(pid, null);
    return null;
  }

  private connectionKey(metric: StreamMetrics): string {
    return `${metric.peer_ip}_${metric.local_ip}`;
  }

  private assignStreams(metrics: StreamMetrics[]): void {
    const now = this.now();
    const currentKeys = new Set<string>();

    const newInbounds: { key: string; metric: StreamMetrics }[] = [];
    const newOutbounds: { key: string; metric: StreamMetrics }[] = [];

    for (const metric of metrics) {
      const key = this.connectionKey(metric);
      currentKeys.add(key);

      if (metric.stream_id && !this.activeStreams.has(metric.stream_id)) {
        this.activeStreams.set(metric.stream_id, { startedAt: now, inboundKey: "", loggedStart: true });
      }

      if (metric.stream_id) {
        this.connectionToStream.set(key, metric.stream_id);
      }

      const existingStreamId = this.connectionToStream.get(key);
      if (existingStreamId) {
        metric.stream_id = existingStreamId;
      }

      if (!this.firstSeen.has(key)) {
        this.firstSeen.set(key, now);
        if (metric.target === "INBOUND") {
          newInbounds.push({ key, metric });
        } else if (!metric.stream_id) {
          newOutbounds.push({ key, metric });
        } else {
          this.eventLog.push({
            timestamp: new Date(now).toISOString(),
            type: "target_connected",
            protocol: "RTMP",
            streamId: metric.stream_id,
            target: metric.target,
            peerIp: metric.peer_ip,
          });
        }
      }
    }

    for (const { key, metric } of newInbounds) {
      this.streamCounter += 1;
      const streamId = `stream-${this.streamCounter}`;
      this.activeStreams.set(streamId, { startedAt: now, inboundKey: key, loggedStart: false });
      this.connectionToStream.set(key, streamId);
      metric.stream_id = streamId;
    }

    for (const { key, metric } of newOutbounds) {
      let bestStreamId: string | null = null;
      let bestTimeDiff = Infinity;

      for (const [streamId, stream] of this.activeStreams) {
        const diff = Math.abs(now - stream.startedAt);
        if (diff <= StreamMonitor.ASSOCIATION_WINDOW_MS && diff < bestTimeDiff) {
          bestTimeDiff = diff;
          bestStreamId = streamId;
        }
      }

      if (!bestStreamId) {
        for (const [streamId, stream] of this.activeStreams) {
          if (currentKeys.has(stream.inboundKey)) {
            const diff = Math.abs(now - stream.startedAt);
            if (!bestStreamId || diff < bestTimeDiff) {
              bestTimeDiff = diff;
              bestStreamId = streamId;
            }
          }
        }
      }

      if (bestStreamId) {
        this.connectionToStream.set(key, bestStreamId);
        metric.stream_id = bestStreamId;
      }
    }

    // Evaluate stream_start
    for (const metric of metrics) {
      if (metric.target === "INBOUND" && metric.stream_id) {
        const state = this.activeStreams.get(metric.stream_id);
        if (state && !state.loggedStart) {
          let hasOutbound = false;
          for (const m of metrics) {
            if (m.stream_id === metric.stream_id && m.target !== "INBOUND") {
              hasOutbound = true;
              break;
            }
          }
          if (hasOutbound || metric.bytes_received > 4096) {
            state.loggedStart = true;
            this.eventLog.push({
              timestamp: new Date(now).toISOString(),
              type: "stream_start",
              protocol: "RTMP",
              streamId: metric.stream_id,
              target: metric.target,
              peerIp: metric.peer_ip,
            });
          }
        }
      }
    }

    // Evaluate target_connected for new outbounds
    for (const { metric } of newOutbounds) {
      if (metric.stream_id) {
        const state = this.activeStreams.get(metric.stream_id);
        if (state?.loggedStart) {
          this.eventLog.push({
            timestamp: new Date(now).toISOString(),
            type: "target_connected",
            protocol: "RTMP",
            streamId: metric.stream_id,
            target: metric.target,
            peerIp: metric.peer_ip,
          });
        }
      }
    }

    const emittedStreamEnds = new Set<string>();

    for (const [key] of this.firstSeen) {
      if (!currentKeys.has(key)) {
        this.firstSeen.delete(key);
        this.connectionToStream.delete(key);

        const lastKnown = this.lastKnownConnections.get(key);
        if (lastKnown && lastKnown.loggedStart) {
          if (lastKnown.target === "INBOUND") {
            this.eventLog.push({
              timestamp: new Date(now).toISOString(),
              type: "stream_end",
              protocol: "RTMP",
              streamId: lastKnown.streamId,
              target: lastKnown.target,
              peerIp: lastKnown.peerIp,
            });
            emittedStreamEnds.add(lastKnown.streamId);
          } else {
            this.eventLog.push({
              timestamp: new Date(now).toISOString(),
              type: "target_disconnected",
              protocol: "RTMP",
              streamId: lastKnown.streamId,
              target: lastKnown.target,
              peerIp: lastKnown.peerIp,
            });
          }
        }
        if (lastKnown) {
          this.lastKnownConnections.delete(key);
        }
      }
    }

    for (const [streamId, streamState] of this.activeStreams) {
      let hasActive = false;
      for (const [, sid] of this.connectionToStream) {
        if (sid === streamId) {
          hasActive = true;
          break;
        }
      }
      if (!hasActive) {
        this.activeStreams.delete(streamId);
        if (streamState.loggedStart && !emittedStreamEnds.has(streamId) && streamState.inboundKey !== "") {
          const inboundLastKnown = this.lastKnownConnections.get(streamState.inboundKey);
          this.eventLog.push({
            timestamp: new Date(now).toISOString(),
            type: "stream_end",
            protocol: "RTMP",
            streamId,
            target: "INBOUND",
            peerIp: inboundLastKnown?.peerIp ?? null,
          });
        }
      }
    }

    for (const metric of metrics) {
      if (metric.stream_id) {
        const state = this.activeStreams.get(metric.stream_id);
        this.lastKnownConnections.set(this.connectionKey(metric), {
          target: metric.target,
          streamId: metric.stream_id,
          peerIp: metric.peer_ip,
          loggedStart: state?.loggedStart ?? false,
        });
      }
    }
  }

  private buildLogicalStreams(metrics: StreamMetrics[]): LogicalStream[] {
    const streamMap = new Map<string, LogicalStream>();

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

    // Filter out streams that haven't formally started (scanner noise)
    return [...streamMap.values()].filter((stream) => {
      const state = this.activeStreams.get(stream.id);
      return state?.loggedStart !== false;
    });
  }

  private calculateHealthAndSpeed(target: StreamMetrics) {
    const stateKey = `${target.peer_ip}_${target.local_ip}`;
    const prevState = this.states.get(stateKey);
    const wallClockNow = this.now();
    const sampleTimestamp =
      prevState && this.pendingMockElapsedMs !== null ? prevState.timestamp + this.pendingMockElapsedMs : wallClockNow;

    let dropPercent = 0;
    let retransPenalty = 0;
    target.is_first_tick = !prevState;

    if (prevState) {
      const timeDiffSec = (sampleTimestamp - prevState.timestamp) / 1000;
      const deltaSent = target.bytes_sent - prevState.bytes_sent;
      const deltaReceived = target.bytes_received - prevState.bytes_received;
      const deltaRetrans = target.bytes_retrans - prevState.bytes_retrans;
      const deltaRetransPackets = target.retrans_total - prevState.retrans_total;
      const deltaDataSegments = target.data_segs_out - prevState.data_segs_out;

      if (deltaSent > 0 && deltaRetrans > 0) {
        dropPercent = (deltaRetrans / deltaSent) * 100;
      }

      if (deltaRetransPackets > 0 && deltaDataSegments > 0) {
        retransPenalty = (deltaRetransPackets / deltaDataSegments) * 100;
      }
    }

    const previousSamples = this.throughputSamples.get(stateKey) ?? [];
    const lastSample = previousSamples[previousSamples.length - 1];
    const countersReset =
      !!lastSample && (target.bytes_sent < lastSample.bytes_sent || target.bytes_received < lastSample.bytes_received);

    const nextSamples = countersReset
      ? [{ bytes_sent: target.bytes_sent, bytes_received: target.bytes_received, timestamp: sampleTimestamp }]
      : [
          ...previousSamples,
          { bytes_sent: target.bytes_sent, bytes_received: target.bytes_received, timestamp: sampleTimestamp },
        ].slice(-StreamMonitor.RATE_WINDOW_SAMPLE_COUNT);

    this.throughputSamples.set(stateKey, nextSamples);

    if (nextSamples.length >= 2) {
      const firstSample = nextSamples[0]!;
      const latestSample = nextSamples[nextSamples.length - 1]!;
      const windowSeconds = (latestSample.timestamp - firstSample.timestamp) / 1000;
      const sentDelta = latestSample.bytes_sent - firstSample.bytes_sent;
      const receivedDelta = latestSample.bytes_received - firstSample.bytes_received;

      target.tx_bps =
        sentDelta > 0 && windowSeconds > 0 ? Math.round((sentDelta * 8) / windowSeconds) : (prevState?.tx_bps ?? 0);

      target.rx_bps =
        receivedDelta > 0 && windowSeconds > 0
          ? Math.round((receivedDelta * 8) / windowSeconds)
          : (prevState?.rx_bps ?? 0);
    } else {
      target.tx_bps = prevState?.tx_bps ?? 0;
      target.rx_bps = prevState?.rx_bps ?? 0;
    }

    let health = 100;

    if (target.target === "INBOUND") {
      if (target.recv_q > 50000) {
        health -= Math.min(40, (target.recv_q - 50000) / 10000);
      }
    } else {
      const estimatedSendDelayMs = StreamMonitor.estimateSendDelayMs(target);
      const backlogPenalty = StreamMonitor.estimateBacklogPenalty(target);
      health = 100 - retransPenalty - estimatedSendDelayMs * 4 - backlogPenalty;
    }

    target.health = Math.max(0, Math.min(100, Math.round(health)));
    target.drop_percent = Number(dropPercent.toFixed(2));

    this.states.set(stateKey, {
      bytes_sent: target.bytes_sent,
      bytes_retrans: target.bytes_retrans,
      bytes_received: target.bytes_received,
      retrans_total: target.retrans_total,
      data_segs_out: target.data_segs_out,
      tx_bps: target.tx_bps,
      rx_bps: target.rx_bps,
      timestamp: sampleTimestamp,
    });
  }

  private async resolveRtmpTargets(metrics: StreamMetrics[]): Promise<void> {
    const unresolvedMetrics = metrics.filter((metric) => StreamMonitor.needsRtmpTargetResolution(metric));
    if (unresolvedMetrics.length === 0) {
      return;
    }

    const resolvedTargets = new Map<string, ResolvedRtmpTarget>();
    const uniqueIps = [...new Set(unresolvedMetrics.map((metric) => StreamMonitor.extractIp(metric.peer_ip)))].filter(
      (ip): ip is string => Boolean(ip),
    );

    await Promise.all(
      uniqueIps.map(async (ip) => {
        const target = await this.rtmpTargetResolver.resolveTarget(ip);
        resolvedTargets.set(ip, target);
      }),
    );

    for (const metric of unresolvedMetrics) {
      const ip = StreamMonitor.extractIp(metric.peer_ip);
      if (!ip) {
        metric.target = "UNKNOWN";
        continue;
      }

      metric.target = resolvedTargets.get(ip) ?? "UNKNOWN";
    }
  }

  private static needsRtmpTargetResolution(metric: StreamMetrics): boolean {
    return metric.target === "UNKNOWN" && metric.peer_ip !== null && !metric.peer_ip.startsWith("127.0.0.1");
  }

  private static isMonitoredInboundAddress(address: string | null): boolean {
    if (!address) {
      return false;
    }

    return RTMP_MONITOR_INBOUND_PORTS.some((port) => address.endsWith(`:${port}`));
  }

  private static extractIp(address: string | null): string | null {
    if (!address) {
      return null;
    }

    if (address.startsWith("[")) {
      return address.slice(1, address.lastIndexOf("]")) || null;
    }

    const lastColon = address.lastIndexOf(":");
    if (lastColon <= 0) {
      return address;
    }

    return address.slice(0, lastColon);
  }

  private static estimateSendDelayMs(target: StreamMetrics): number {
    const hasNotsent = target.notsent > 0;
    const queuedBytes = hasNotsent ? target.notsent : target.send_q;
    if (queuedBytes <= 0 || target.tx_kernel_bps <= 0 || target.mss <= 0) {
      return 0;
    }

    const queuedPackets = queuedBytes / target.mss;
    const queuePressure = Math.min(1, queuedPackets / 32);
    const packetSerializationMs = (target.mss * 8 * 1000) / target.tx_kernel_bps;
    const fallbackMultiplier = hasNotsent ? 1 : 1.8;

    return packetSerializationMs * queuePressure * fallbackMultiplier;
  }

  private static estimateBacklogPenalty(target: StreamMetrics): number {
    if (target.notsent <= 0 || target.tx_kernel_bps <= 0) {
      return 0;
    }

    const bufferedMs = (target.notsent * 8 * 1000) / target.tx_kernel_bps;
    const excessBufferedMs = Math.max(0, bufferedMs - 150);

    return Math.min(25, excessBufferedMs / 25);
  }

  private static executeSsCommand(): CommandExecutionResult {
    if (process.platform === "win32") {
      return {
        success: false,
        stdout: "",
        stderr: "",
        error: "Stream monitoring via ss -itnop is only available on Linux hosts.",
      };
    }

    try {
      let result = Bun.spawnSync(["ss", "-itnop"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        result = Bun.spawnSync(["sh", "-c", "ss -itnop"], {
          stdout: "pipe",
          stderr: "pipe",
        });
      }

      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();

      if (result.exitCode !== 0) {
        return {
          success: false,
          stdout,
          stderr,
          error: stderr.trim() || `ss -itnop exited with code ${result.exitCode}`,
        };
      }

      return {
        success: true,
        stdout,
        stderr,
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
