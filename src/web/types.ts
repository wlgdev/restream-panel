import type {
  BandwidthPoint,
  EventTargetMetrics,
  StreamEvent,
  Track,
  TrackCodecProps,
} from "../core/types";

export type { BandwidthPoint, EventTargetMetrics, StreamEvent, Track, TrackCodecProps };

// One live connection row: an RTMP(S) socket or an SRT session. Shaped to accept
// the monitor's StreamMetrics/SrtMetrics verbatim (extra source fields pass through).
export interface ConnectionItem {
  protocol?: "RTMP" | "RTMPS" | "SRT" | "SRTLA";
  target: string;
  stream_id?: string;
  health: number;
  peer_ip: string | null;
  mode?: string;
  tx_bps: number;
  rx_bps: number;
  link_capacity_bps?: number;
  bytes_sent: number;
  bytes_received: number;
  rtt: number;
  rtt_jitter?: number;
  recv_q: number;
  send_q: number;
  recv_buffer_ms?: number;
  send_buffer_ms?: number;
  tsbpd_delay_ms?: number;
  drop_percent: number;
  retrans_total: number;
  flight_size?: number;
  flow_window?: number;
  is_first_tick?: boolean;
}

export interface LogicalStreamItem {
  id: string;
  startedAt: number;
  inbound: ConnectionItem | null;
  outbound: ConnectionItem[];
  tracks?: Track[];
}

// Full monitor frame pushed over SSE every tick: logical streams already merged
// server-side across protocols, plus connections matched to no stream.
export interface MonitorSnapshot {
  streams: LogicalStreamItem[];
  orphans: ConnectionItem[];
  events: StreamEvent[];
  bandwidth?: Record<string, BandwidthPoint[]>;
  errors: string[];
  timestamp: string;
}
