import type { StreamEventLog } from "../event-log";
import type { StreamBandwidthLog } from "../bandwidth-log";
import { MediamtxCollector, type SrtMetrics, type PathInfoOptions } from "../collectors/mediamtx-collector";
import type { LogicalStream } from "../types";

export interface SrtSnapshot {
  success: boolean;
  data: SrtMetrics[];
  streams: LogicalStream[];
  timestamp: string;
  error?: string;
}

interface ActiveSrtStreamState {
  startedAt: number;
}

interface SrtGroupingOptions {
  metricsFetcher?: () => Promise<{ success: boolean; stdout: string; stderr: string; error?: string }>;
  now?: () => number;
  useMockData?: boolean;
  mockOutputs?: Array<string | { stdout: string; elapsedMs?: number }>;
  eventLog?: StreamEventLog;
  streamBandwidthLog?: StreamBandwidthLog;
  pathInfo?: PathInfoOptions;
}

// SRT grouping over MediamtxCollector: detects stream start/end, builds logical
// streams and records bandwidth. Owned by MonitorManager. Fetch/parse/health live
// in the collector, which is also the single source of forward/publish correlation
// maps and path track metadata.
export class SrtGrouping {
  private lastSnapshot: SrtSnapshot = {
    success: true,
    data: [],
    streams: [],
    timestamp: new Date(0).toISOString(),
  };

  private readonly activeStreams = new Map<string, ActiveSrtStreamState>();
  private readonly lastKnownConnections = new Map<string, { target: string; peerIp: string | null }>();

  // Mirrored from the collector each tick; consumed by StreamMonitor to correlate
  // mediamtx outbound RTMP sockets (forwardMap) and publisher sockets (publishMap).
  private lastForwardMap = new Map<string, string>();
  private lastPublishMap = new Map<string, string>();

  private readonly collector: MediamtxCollector;
  private readonly now: () => number;
  private readonly eventLog?: StreamEventLog;
  private readonly streamBandwidthLog?: StreamBandwidthLog;

  public constructor(options: SrtGroupingOptions = {}) {
    this.collector = new MediamtxCollector({
      metricsFetcher: options.metricsFetcher,
      now: options.now,
      useMockData: options.useMockData,
      mockOutputs: options.mockOutputs,
      pathInfo: options.pathInfo,
    });
    this.now = options.now ?? Date.now;
    this.eventLog = options.eventLog;
    this.streamBandwidthLog = options.streamBandwidthLog;
  }

  public parse(output: string) {
    return this.collector.parse(output);
  }

  public parseSrtlaPaths(output: string): Set<string> {
    return this.collector.parseSrtlaPaths(output);
  }

  public parseForwardDestinations(output: string) {
    return this.collector.parseForwardDestinations(output);
  }

  public parseRtmpConnections(output: string) {
    return this.collector.parseRtmpConnections(output);
  }

  public getForwardMap(): Map<string, string> {
    return this.lastForwardMap;
  }

  public getPublishMap(): Map<string, string> {
    return this.lastPublishMap;
  }

  public async collectOnce(): Promise<SrtSnapshot> {
    const result = await this.collector.collect();
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

    this.lastForwardMap = result.forwardMap;
    this.lastPublishMap = result.publishMap;
    this.syncActiveStreams(result.metrics);
    await this.ensurePathTracks(result.metrics);
    const streams = this.buildLogicalStreams(result.metrics);
    this.streamBandwidthLog?.recordStreams(streams, Math.floor(this.now() / 1000));

    this.lastSnapshot = {
      success: true,
      data: result.metrics,
      streams,
      timestamp,
    };
    return this.lastSnapshot;
  }

  public getSnapshot(): SrtSnapshot {
    return this.lastSnapshot;
  }

  // Track metadata for the RTMP side: delegates to the collector, the single
  // mediamtx source. Lets MonitorManager pass one SrtGrouping as RtmpGrouping's
  // TrackSource.
  public ensurePaths(paths: Iterable<string>): Promise<void> {
    return this.collector.ensurePaths(paths);
  }

  public getTracks(path: string) {
    return this.collector.getTracks(path);
  }

  public getReaders(path: string) {
    return this.collector.getReaders(path);
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

  private buildLogicalStreams(metrics: SrtMetrics[]): LogicalStream[] {
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
          tracks: this.collector.getTracks(metric.stream_id) ?? undefined,
          readers: this.collector.getReaders(metric.stream_id),
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

  // Lazy-load mediamtx path tracks once per seen path. Triggered from collectOnce after new-stream
  // detection so that logical streams (which carry the path as their id) can attach track info
  // without a per-tick re-fetch of /v3/paths/list.
  private async ensurePathTracks(metrics: SrtMetrics[]): Promise<void> {
    const paths = new Set<string>();
    for (const metric of metrics) {
      if (metric.stream_id) paths.add(metric.stream_id);
    }
    if (paths.size === 0) return;
    await this.collector.ensurePaths(paths);
  }
}
