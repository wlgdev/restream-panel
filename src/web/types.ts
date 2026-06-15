export interface PushTarget {
  serverId: string;
  serverName: string;
  serverUrl: string;
  streamKey: string;
}

export interface Application {
  name: string;
  isProtected: boolean;
  pushTargets: PushTarget[];
}

export interface Server {
  id: string;
  name: string;
  url: string;
  requiresStreamKey: boolean;
  supportsDynamicStreamKey?: boolean;
}

export interface StreamTarget {
  id: string;
  name: string;
  listenPort: number;
  proxyPass: string;
  obsPath: string;
  transportLabel: string;
  protectedLabel: string;
  targetServerName: string;
}

export interface SystemStatus {
  nginx: {
    running: boolean;
    version: string;
  };
  app?: {
    ip: string;
  };
}

export interface AlertState {
  type: "success" | "error" | "warning";
  message: string;
}

export interface StreamHealthItem {
  protocol?: "RTMP" | "SRT";
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
  inbound: StreamHealthItem | null;
  outbound: StreamHealthItem[];
}

export interface HealthSnapshot {
  success: boolean;
  timestamp: string;
  data: StreamHealthItem[];
  streams: LogicalStreamItem[];
  error?: string;
}

export interface EventTargetMetrics {
  health: number;
  tx_bps: number;
  rx_bps: number;
  bytes_sent: number;
  bytes_received: number;
  rtt: number;
  send_q: number;
  recv_q: number;
  drop_percent: number;
  retrans_total: number;
}

export interface StreamEvent {
  seq: number;
  timestamp: string;
  type: "stream_start" | "stream_end" | "target_connected" | "target_disconnected" | "quality_degraded";
  protocol: "RTMP" | "SRT";
  streamId: string;
  target: string;
  peerIp: string | null;
  metrics?: EventTargetMetrics;
}

export interface CombinedHealthSnapshot {
  rtmp: HealthSnapshot;
  srt: HealthSnapshot;
  events: StreamEvent[];
}
