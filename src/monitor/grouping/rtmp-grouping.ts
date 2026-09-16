import type { RtmpTargetResolver } from "../collectors/rtmp-target-resolver";
import { StreamEventLog } from "../event-log";
import type { StreamBandwidthLog } from "../bandwidth-log";
import { SsCollector, type StreamMetrics } from "../collectors/ss-collector";
import { isMonitoredInboundAddress } from "../net-addr";
import type { LogicalStream, TrackSource } from "../types";

export interface RtmpSnapshot {
  success: boolean;
  data: StreamMetrics[];
  streams: LogicalStream[];
  timestamp: string;
  error?: string;
}

interface CommandExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

interface RtmpGroupingOptions {
  commandExecutor?: () => CommandExecutionResult;
  now?: () => number;
  useMockData?: boolean;
  mockOutputs?: Array<string | { stdout: string; elapsedMs?: number }>;
  intervalMs?: number;
  rtmpTargetResolver?: Pick<RtmpTargetResolver, "resolveTarget">;
  forwardMapProvider?: () => Map<string, string>;
  publishMapProvider?: () => Map<string, string>;
  eventLog?: StreamEventLog;
  streamBandwidthLog?: StreamBandwidthLog;
  tracks?: TrackSource;
}

interface ActiveStreamState {
  startedAt: number;
  inboundKey: string;
  loggedStart?: boolean;
}

// RTMP grouping over SsCollector: associates sockets to logical streams, filters
// scanner noise and emits RTMP stream events. Owned by MonitorManager, which wires
// the mediamtx forward/publish maps in via the providers. TCP fetch/parse/health
// live in the collector.
export class RtmpGrouping {
  private static readonly ASSOCIATION_WINDOW_MS = 10_000;
  private static readonly INBOUND_CONFIRM_MIN_BYTES = 4096;
  private static readonly INBOUND_CONFIRM_MIN_AGE_WINDOW_MULTIPLIER = 1.5;
  private static readonly INBOUND_CONFIRM_MIN_RX_BPS = 16_000;
  private lastSnapshot: RtmpSnapshot = {
    success: true,
    data: [],
    streams: [],
    timestamp: new Date(0).toISOString(),
  };

  private readonly firstSeen = new Map<string, number>();
  private readonly connectionToStream = new Map<string, string>();
  private readonly activeStreams = new Map<string, ActiveStreamState>();
  private streamCounter = 0;

  private readonly collector: SsCollector;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly forwardMapProvider?: () => Map<string, string>;
  private readonly publishMapProvider?: () => Map<string, string>;
  private readonly eventLog: StreamEventLog;
  private readonly streamBandwidthLog?: StreamBandwidthLog;
  private readonly tracks?: TrackSource;
  private readonly lastKnownConnections = new Map<string, { target: string; streamId: string; peerIp: string | null; loggedStart?: boolean }>();

  public constructor(options: RtmpGroupingOptions = {}) {
    this.collector = new SsCollector({
      commandExecutor: options.commandExecutor,
      now: options.now,
      useMockData: options.useMockData,
      mockOutputs: options.mockOutputs,
      rtmpTargetResolver: options.rtmpTargetResolver,
    });
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 5000;
    this.forwardMapProvider = options.forwardMapProvider;
    this.publishMapProvider = options.publishMapProvider;
    this.eventLog = options.eventLog ?? new StreamEventLog();
    this.streamBandwidthLog = options.streamBandwidthLog;
    this.tracks = options.tracks;
  }

  public getEventsSince(since?: number) {
    return this.eventLog.getSince(since);
  }

  public parse(ssOutput: string): StreamMetrics[] {
    return this.collector.parse(ssOutput);
  }

  public async collectOnce(): Promise<RtmpSnapshot> {
    const result = await this.collector.collect({
      forwardMap: this.forwardMapProvider?.() ?? new Map<string, string>(),
      publishMap: this.publishMapProvider?.() ?? new Map<string, string>(),
    });
    const timestamp = new Date().toISOString();

    if (!result.success) {
      this.lastSnapshot = {
        success: false,
        data: [],
        streams: [],
        timestamp,
        error: result.error,
      };
      return this.lastSnapshot;
    }

    const data = result.metrics;
    this.assignStreams(data);
    await this.ensurePathTracks(data);
    const visibleData = this.filterVisibleMetrics(data);
    const streams = this.buildLogicalStreams(visibleData);
    this.streamBandwidthLog?.recordStreams(streams, Math.floor(this.now() / 1000));

    for (const metric of visibleData) {
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
      data: visibleData,
      streams,
      timestamp,
    };
    return this.lastSnapshot;
  }

  public getSnapshot(): RtmpSnapshot {
    return this.lastSnapshot;
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
        // A path id on an INBOUND metric (publisher correlated via the mediamtx publish map)
        // starts unconfirmed like a synthetic stream-N inbound, so stream_start still fires
        // once payload is confirmed below. Outbound-labeled ids keep pre-started semantics.
        this.activeStreams.set(metric.stream_id, {
          startedAt: now,
          inboundKey: "",
          loggedStart: metric.target !== "INBOUND",
        });
      }

      if (metric.stream_id) {
        this.connectionToStream.set(key, metric.stream_id);
      }

      const existingStreamId = this.connectionToStream.get(key);
      if (existingStreamId) {
        metric.stream_id = existingStreamId;
      }

      // A socket owned by mediamtx on a monitored inbound port is an accepted publisher (or
      // direct RTMP reader), never an outbound dial. Until the publish map knows its peer it
      // stays unclassified — but it must not grab a time-window association slot belonging
      // to an unrelated stream during that first tick.
      const isMediamtxListenerSocket =
        metric.target !== "INBOUND" &&
        !metric.stream_id &&
        isMonitoredInboundAddress(metric.local_ip);

      if (!this.firstSeen.has(key)) {
        this.firstSeen.set(key, now);
        if (metric.target === "INBOUND") {
          if (this.isConfirmedInbound(metric, now)) {
            newInbounds.push({ key, metric });
          }
        } else if (!metric.stream_id && !isMediamtxListenerSocket) {
          newOutbounds.push({ key, metric });
        } else if (metric.stream_id) {
          this.eventLog.push({
            timestamp: new Date(now).toISOString(),
            type: "target_connected",
            protocol: "RTMP",
            streamId: metric.stream_id,
            target: metric.target,
            peerIp: metric.peer_ip,
          });
        }
        // Remaining case — an uncorrelated mediamtx listener socket — is held out of both
        // association paths until the publish map identifies its peer (or the socket goes
        // away), so it cannot grab a time-window slot belonging to an unrelated stream.
      } else if (metric.target === "INBOUND" && !metric.stream_id && this.isConfirmedInbound(metric, now)) {
        newInbounds.push({ key, metric });
      } else if (metric.target !== "INBOUND" && !metric.stream_id && !isMediamtxListenerSocket) {
        newOutbounds.push({ key, metric });
      }
    }

    for (const { key, metric } of newInbounds) {
      // A publisher correlated through the mediamtx publish map already carries its path as
      // stream_id ("cloudru"); reuse it so the logical stream merges with consumers of the
      // same path across monitors instead of spawning a synthetic stream-N. The entry may
      // already exist from the pre-registration pass above — rebind its inboundKey only.
      let streamId = metric.stream_id;
      if (!streamId) {
        this.streamCounter += 1;
        streamId = `stream-${this.streamCounter}`;
      }
      const existingState = this.activeStreams.get(streamId);
      if (existingState) {
        existingState.inboundKey = key;
      } else {
        this.activeStreams.set(streamId, { startedAt: now, inboundKey: key, loggedStart: false });
      }
      this.connectionToStream.set(key, streamId);
      metric.stream_id = streamId;
    }

    for (const { key, metric } of newOutbounds) {
      let bestStreamId: string | null = null;
      let bestTimeDiff = Infinity;

      for (const [streamId, stream] of this.activeStreams) {
        const diff = Math.abs(now - stream.startedAt);
        if (diff <= RtmpGrouping.ASSOCIATION_WINDOW_MS && diff < bestTimeDiff) {
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
          if (hasOutbound || this.isConfirmedInbound(metric, now)) {
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

  private filterVisibleMetrics(metrics: StreamMetrics[]): StreamMetrics[] {
    return metrics.filter((metric) => {
      if (metric.target !== "INBOUND" || metric.stream_id) {
        return true;
      }

      return this.isConfirmedInbound(metric, this.now());
    });
  }

  private isConfirmedInbound(metric: StreamMetrics, now: number): boolean {
    if (metric.target !== "INBOUND") {
      return true;
    }

    if (metric.bytes_received >= RtmpGrouping.INBOUND_CONFIRM_MIN_BYTES) {
      return true;
    }

    const firstSeenAt = this.firstSeen.get(this.connectionKey(metric)) ?? now;
    const ageMs = now - firstSeenAt;
    const minAgeMs = this.intervalMs * RtmpGrouping.INBOUND_CONFIRM_MIN_AGE_WINDOW_MULTIPLIER;

    return ageMs >= minAgeMs && metric.rx_bps >= RtmpGrouping.INBOUND_CONFIRM_MIN_RX_BPS;
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
          tracks: this.tracks?.getTracks(metric.stream_id) ?? undefined,
          readers: this.tracks?.getReaders?.(metric.stream_id),
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

  // Lazy-load mediamtx path tracks once per seen path. Triggered from collectOnce after
  // stream assignment so logical streams (path-backed by mediamtx) can surface track info
  // without a per-tick re-fetch of /v3/paths/list.
  private async ensurePathTracks(metrics: StreamMetrics[]): Promise<void> {
    if (!this.tracks) return;
    const paths = new Set<string>();
    for (const metric of metrics) {
      if (metric.stream_id) paths.add(metric.stream_id);
    }
    if (paths.size === 0) return;
    await this.tracks.ensurePaths(paths);
  }

}
