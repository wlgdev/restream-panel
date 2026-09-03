import * as fs from "node:fs";
import { RtmpTargetResolver, type ResolvedRtmpTarget } from "./rtmp-target-resolver";
import {
  canonicalAddr,
  extractIp,
  isLoopbackAddress,
  isMonitoredInboundAddress,
  normalizeAddr,
} from "../net-addr";

export interface StreamMetrics {
  target: string;
  protocol: "RTMP" | "RTMPS";
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

export interface SsMaps {
  forwardMap: Map<string, string>;
  publishMap: Map<string, string>;
}

export type SsCollectResult =
  | { success: true; metrics: StreamMetrics[] }
  | { success: false; error: string };

export interface SsCollectorOptions {
  commandExecutor?: () => CommandExecutionResult;
  now?: () => number;
  useMockData?: boolean;
  mockOutputs?: Array<string | MockOutput>;
  rtmpTargetResolver?: Pick<RtmpTargetResolver, "resolveTarget">;
}

// Runs `ss -itnop`, parses TCP sockets into per-connection RTMP metrics and calibrates
// health/rates. mediamtx correlation maps (remoteAddr -> path) are mirrored per tick so
// outbound sockets (no path of their own) and publisher sockets (shared mediamtx process)
// resolve to a path. Grouping, events and snapshots stay in the monitor/aggregator layer.
export class SsCollector {
  private static readonly RATE_WINDOW_SAMPLE_COUNT = 4;
  private readonly processStreamIdCache = new Map<number, string | null>();
  private readonly states = new Map<string, PreviousState>();
  private readonly throughputSamples = new Map<string, ThroughputSample[]>();
  private mockIndex = 0;
  private pendingMockElapsedMs: number | null = null;

  // remoteAddr (ip:port) -> path, mirrored from the mediamtx forward/publish maps each
  // tick so parse() can correlate sockets that carry no path of their own.
  private lastForwardMap = new Map<string, string>();
  private lastPublishMap = new Map<string, string>();

  private readonly commandExecutor: () => CommandExecutionResult;
  private readonly now: () => number;
  private readonly useMockData: boolean;
  private readonly mockOutputs: Array<string | MockOutput>;
  private readonly rtmpTargetResolver: Pick<RtmpTargetResolver, "resolveTarget">;

  public constructor(options: SsCollectorOptions = {}) {
    this.commandExecutor = options.commandExecutor ?? SsCollector.executeSsCommand;
    this.now = options.now ?? Date.now;
    this.useMockData = options.useMockData ?? false;
    this.mockOutputs = options.mockOutputs ?? [];
    this.rtmpTargetResolver = options.rtmpTargetResolver ?? new RtmpTargetResolver();
  }

  public async collect(maps?: SsMaps): Promise<SsCollectResult> {
    this.lastForwardMap = maps?.forwardMap ?? new Map<string, string>();
    this.lastPublishMap = maps?.publishMap ?? new Map<string, string>();

    const commandResult = this.getCommandResult();

    if (!commandResult.success) {
      return {
        success: false,
        error: commandResult.error ?? commandResult.stderr ?? "Failed to run ss -itnop",
      };
    }

    try {
      const metrics = this.parse(commandResult.stdout);
      await this.resolveRtmpTargets(metrics);
      return { success: true, metrics };
    } catch (error) {
      return {
        success: false,
        error: `Failed to parse ss output: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
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

        // Loopback<->loopback sockets are internal relays (mediamtx<->ffmpeg, mediamtx metrics
        // endpoint, etc.): a real stream's peer is always a remote encoder or remote RTMP target.
        // Drop them outright rather than letting one slip through as a bogus UNKNOWN stream.
        if (isLoopbackAddress(peerAddress)) {
          continue;
        }

        // A mediamtx socket whose peer matches an active rtmp_conns publisher IS that
        // publisher's accepted connection: in a direct-to-mediamtx deployment ss only
        // attributes it to the shared mediamtx process, so without this correlation it
        // would fall into the generic mediamtx branch below and never group with its path.
        const publishPath = line.includes("mediamtx") ? this.lookupPublishPath(peerAddress) : undefined;

        if (peerAddress.endsWith(":443") && line.includes("stunnel4")) {
          targetName = "TWITCH";
        } else if (publishPath) {
          targetName = "INBOUND";
        } else if (
          (line.includes("ffmpeg") || line.includes("mediamtx")) &&
          !isLoopbackAddress(peerAddress)
        ) {
          targetName = "UNKNOWN";
        } else if (
          isMonitoredInboundAddress(peerAddress) &&
          line.includes("nginx") &&
          !isLoopbackAddress(peerAddress)
        ) {
          targetName = "UNKNOWN";
        } else if (
          isMonitoredInboundAddress(localAddress) &&
          line.includes("nginx") &&
          !isLoopbackAddress(localAddress)
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
            protocol:
              targetName === "INBOUND"
                ? "RTMP"
                : peerAddress.endsWith(":443")
                  ? "RTMPS"
                  : "RTMP",
            recv_q: recvQ,
            send_q: sendQ,
            local_ip: localAddress,
            peer_ip: peerAddress,
            pid,
            stream_id:
              publishPath ??
              (line.includes("ffmpeg")
                ? (this.getFfmpegStreamId(pid) ?? undefined)
                : this.getForwardStreamId(peerAddress)),
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

  private getForwardStreamId(peerAddress: string): string | undefined {
    // mediamtx outbound RTMP sockets carry no path of their own (mediamtx is one
    // process shared by all forwards, so cmdline cannot disambiguate them the way
    // it does for per-stream ffmpeg). Correlate them against the forward_dests
    // remoteAddr -> path map mirrored from the mediamtx metrics. Try the bracket-stripped
    // form first, then the raw address, so an IPv6 peer matches regardless of
    // whether mediamtx emitted its remoteAddr with surrounding brackets.
    return (
      this.lastForwardMap.get(normalizeAddr(peerAddress)) ??
      this.lastForwardMap.get(peerAddress)
    );
  }

  private lookupPublishPath(peerAddress: string): string | undefined {
    // Correlate a socket's peer against the rtmp_conns publisher map mirrored from
    // mediamtx metrics. ss renders an IPv4 peer accepted on an IPv6 listener as a bracketed
    // IPv4-mapped address ("[::ffff:1.2.3.4]:5678") while mediamtx reports the same
    // connection as plain "1.2.3.4:5678"; canonicalAddr reconciles the two. The raw and
    // normalizeAddr fallbacks cover genuine IPv6 peers, mirroring getForwardStreamId.
    return (
      this.lastPublishMap.get(canonicalAddr(peerAddress)) ??
      this.lastPublishMap.get(normalizeAddr(peerAddress)) ??
      this.lastPublishMap.get(peerAddress)
    );
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
        ].slice(-SsCollector.RATE_WINDOW_SAMPLE_COUNT);

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
      const estimatedSendDelayMs = SsCollector.estimateSendDelayMs(target);
      const backlogPenalty = SsCollector.estimateBacklogPenalty(target);
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
    const unresolvedMetrics = metrics.filter((metric) => SsCollector.needsRtmpTargetResolution(metric));
    if (unresolvedMetrics.length === 0) {
      return;
    }

    const resolvedTargets = new Map<string, ResolvedRtmpTarget>();
    const uniqueIps = [...new Set(unresolvedMetrics.map((metric) => extractIp(metric.peer_ip)))].filter(
      (ip): ip is string => Boolean(ip),
    );

    await Promise.all(
      uniqueIps.map(async (ip) => {
        const target = await this.rtmpTargetResolver.resolveTarget(ip);
        resolvedTargets.set(ip, target);
      }),
    );

    for (const metric of unresolvedMetrics) {
      const ip = extractIp(metric.peer_ip);
      if (!ip) {
        metric.target = "UNKNOWN";
        continue;
      }

      metric.target = resolvedTargets.get(ip) ?? "UNKNOWN";
    }
  }

  private static needsRtmpTargetResolution(metric: StreamMetrics): boolean {
    return metric.target === "UNKNOWN" && metric.peer_ip !== null && !isLoopbackAddress(metric.peer_ip);
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
