import type { BandwidthPoint, StreamEvent } from "../core/types";
import { mergeStreams } from "./grouping/merge-streams";
import type { RtmpGrouping } from "./grouping/rtmp-grouping";
import type { SrtGrouping } from "./grouping/srt-grouping";
import type { StreamBandwidthLog } from "./bandwidth-log";
import type { StreamEventLog } from "./event-log";
import type { LogicalStream, MonitorSnapshot } from "./types";

interface MonitorManagerOptions {
  rtmpGrouping: RtmpGrouping;
  srtGrouping: SrtGrouping;
  eventLog: StreamEventLog;
  streamBandwidthLog: StreamBandwidthLog;
  intervalMs?: number;
}

// Single owner of the monitoring pipeline: ticks the mediamtx-backed SRT grouping
// first (so RTMP socket correlation sees fresh forward/publish maps), then the
// ss-backed RTMP grouping, merges both into one logical-stream list and serves
// the frame to SSE subscribers. Grouping lives in grouping/, collection in
// collectors/ — the manager only sequences them and merges the result.
export class MonitorManager {
  private readonly rtmpGrouping: RtmpGrouping;
  private readonly srtGrouping: SrtGrouping;
  private readonly eventLog: StreamEventLog;
  private readonly streamBandwidthLog: StreamBandwidthLog;
  private readonly intervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: MonitorSnapshot = {
    streams: [],
    orphans: [],
    events: [],
    bandwidth: {},
    errors: [],
    timestamp: new Date(0).toISOString(),
  };

  public constructor(options: MonitorManagerOptions) {
    this.rtmpGrouping = options.rtmpGrouping;
    this.srtGrouping = options.srtGrouping;
    this.eventLog = options.eventLog;
    this.streamBandwidthLog = options.streamBandwidthLog;
    this.intervalMs = options.intervalMs ?? 5000;
  }

  public async tick(): Promise<MonitorSnapshot> {
    const srt = await this.srtGrouping.collectOnce();
    const rtmp = await this.rtmpGrouping.collectOnce();

    const errors: string[] = [];
    if (!srt.success && srt.error) errors.push(srt.error);
    if (!rtmp.success && rtmp.error) errors.push(rtmp.error);

    const streams = mergeStreams<LogicalStream>(
      { streams: rtmp.success ? rtmp.streams : [] },
      { streams: srt.success ? srt.streams : [] },
    );

    const orphans: MonitorSnapshot["orphans"] = [
      ...(rtmp.success ? rtmp.data.filter((metric) => !metric.stream_id) : []),
      ...(srt.success ? srt.data.filter((metric) => !metric.stream_id) : []),
    ];

    this.lastSnapshot = {
      streams,
      orphans,
      events: this.eventLog.getSince(),
      bandwidth: this.streamBandwidthLog.getSince(),
      errors,
      timestamp: new Date().toISOString(),
    };
    return this.lastSnapshot;
  }

  public getSnapshot(): MonitorSnapshot {
    return this.lastSnapshot;
  }

  public getEventsSince(since?: number): StreamEvent[] {
    return this.eventLog.getSince(since);
  }

  public getBandwidthSince(sinceTime?: number): Record<string, BandwidthPoint[]> {
    return this.streamBandwidthLog.getSince(sinceTime);
  }

  public startBackgroundPolling(): void {
    if (!this.pollTimer) {
      void this.tick();
      this.pollTimer = setInterval(() => {
        void this.tick();
      }, this.intervalMs);
    }
  }

  public stopAll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
