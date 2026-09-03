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

// Full monitor frame produced by each monitor tick.
export interface MonitorSnapshot {
  streams: LogicalStream[];
  orphans: MonitorConnection[];
  events: StreamEvent[];
  bandwidth: Record<string, BandwidthPoint[]>;
  errors: string[];
  timestamp: string;
}

// What actually goes over SSE. The first frame of a connection is a full
// snapshot (full: true); every following frame carries only what changed
// since the previous one: fresh bandwidth points, fresh events, and the
// current stream/orphan/error state (small and cheap to resend whole).
// bandwidthKeys is the authoritative id list of the server-side bandwidth
// log — clients drop local histories missing from it (evicted idle streams).
export interface MonitorFrame {
  streams: LogicalStream[];
  orphans: MonitorConnection[];
  events: StreamEvent[];
  bandwidth: Record<string, BandwidthPoint[]>;
  errors: string[];
  timestamp: string;
  full: boolean;
  bandwidthKeys: string[];
}

// Track metadata source for grouping. Satisfied structurally by both
// PathInfoService and SrtGrouping (which delegates to its collector).
export interface TrackSource {
  ensurePaths(paths: Iterable<string>): Promise<void>;
  getTracks(path: string): Track[] | undefined;
  getReaders?(path: string): number | undefined;
}
