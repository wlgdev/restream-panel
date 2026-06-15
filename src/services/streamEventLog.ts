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

export class StreamEventLog {
  private static readonly MAX_EVENTS = 1000;
  private readonly buffer: StreamEvent[] = [];
  private seq = 0;

  public push(event: Omit<StreamEvent, "seq">): StreamEvent {
    this.seq += 1;
    const newEvent: StreamEvent = { ...event, seq: this.seq };
    this.buffer.push(newEvent);

    if (this.buffer.length > StreamEventLog.MAX_EVENTS) {
      this.buffer.shift();
    }

    return newEvent;
  }

  public getSince(since?: number): StreamEvent[] {
    if (since === undefined) {
      return [...this.buffer];
    }
    return this.buffer.filter((event) => event.seq > since);
  }
}
