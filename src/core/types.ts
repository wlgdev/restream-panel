// All inner fields are optional — mediamtx emits an empty codecProps object for some codecs.
export interface TrackCodecProps {
  width?: number;
  height?: number;
  profile?: string;
  level?: string;
  sampleRate?: number;
  channelCount?: number;
}

export interface Track {
  codec: string;
  codecProps?: TrackCodecProps;
}

export interface BandwidthPoint {
  time: number;
  inboundBps: number | null;
  outbounds: Record<string, number>;
}

export type StreamEventType =
  | "stream_start"
  | "stream_end"
  | "target_connected"
  | "target_disconnected"
  | "quality_degraded";

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
  type: StreamEventType;
  protocol: "RTMP" | "SRT";
  streamId: string;
  target: string;
  peerIp: string | null;
  metrics?: EventTargetMetrics;
}
