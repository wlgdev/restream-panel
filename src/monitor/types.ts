import type { BandwidthPoint, StreamEvent, Track } from "../core/types";
import type { SrtMetrics } from "./collectors/mediamtx-collector";
import type { StreamMetrics } from "./collectors/ss-collector";

// One live connection from any source (RTMP socket or SRT session).
export type MonitorConnection = StreamMetrics | SrtMetrics;

// A logical stream: all connections (RTMP + SRT) sharing one path id.
export interface LogicalStream {
  id: string;
  startedAt: number;
  inbound: MonitorConnection | null;
  outbound: MonitorConnection[];
  tracks?: Track[];
  readers?: number;
}

// Full monitor frame pushed to SSE subscribers every tick.
export interface MonitorSnapshot {
  streams: LogicalStream[];
  orphans: MonitorConnection[];
  events: StreamEvent[];
  bandwidth: Record<string, BandwidthPoint[]>;
  errors: string[];
  timestamp: string;
}

// Track metadata source for grouping. Satisfied structurally by both
// PathInfoService and SrtGrouping (which delegates to its collector).
export interface TrackSource {
  ensurePaths(paths: Iterable<string>): Promise<void>;
  getTracks(path: string): Track[] | undefined;
  getReaders?(path: string): number | undefined;
}
