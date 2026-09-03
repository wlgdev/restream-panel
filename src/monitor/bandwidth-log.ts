import type { BandwidthPoint } from "../core/types";

export type { BandwidthPoint };

export interface StreamBandwidthItem {
  target: string;
  protocol?: string;
  peer_ip?: string | null;
  rx_bps?: number;
  tx_bps: number;
}

export interface StreamBandwidthSource {
  id: string;
  inbound: StreamBandwidthItem | null;
  outbound: StreamBandwidthItem[];
}

export class StreamBandwidthLog {
  private static readonly MAX_POINTS_PER_STREAM = 2880;
  private static readonly RETENTION_SECONDS = 14400;
  // A stream that received no points for longer than this is considered
  // finished: its history stays viewable until retention prunes it, then the
  // key itself is dropped so the map (and every SSE frame key list) does not
  // grow forever. Default equals retention: a finished stream remains
  // inspectable for the full 4h window after its last point.
  private static readonly IDLE_TTL_SECONDS = StreamBandwidthLog.RETENTION_SECONDS;
  private readonly history = new Map<string, BandwidthPoint[]>();
  private readonly lastSeen = new Map<string, number>();

  public recordStreams(streams: StreamBandwidthSource[], timestampSec?: number): void {
    const time = timestampSec ?? Math.floor(Date.now() / 1000);

    for (const stream of streams) {
      if (!stream.id) continue;

      const outbounds: Record<string, number> = {};
      for (const out of stream.outbound) {
        const key = `${out.target}_${out.peer_ip || out.protocol || "dest"}`;
        outbounds[key] = out.tx_bps;
      }

      const point: BandwidthPoint = {
        time,
        inboundBps: stream.inbound ? (stream.inbound.rx_bps ?? 0) : null,
        outbounds,
      };

      this.recordPoint(stream.id, point);
    }
  }

  public recordPoint(streamId: string, point: BandwidthPoint): void {
    let list = this.history.get(streamId);
    if (!list) {
      list = [];
      this.history.set(streamId, list);
    }
    this.lastSeen.set(streamId, point.time);

    const lastPoint = list[list.length - 1];
    if (lastPoint && Math.abs(lastPoint.time - point.time) <= 2) {
      if (point.inboundBps !== null) {
        lastPoint.inboundBps = point.inboundBps;
      }
      lastPoint.outbounds = { ...lastPoint.outbounds, ...point.outbounds };
      return;
    }

    list.push({
      time: point.time,
      inboundBps: point.inboundBps,
      outbounds: { ...point.outbounds },
    });

    const cutoffTime = point.time - StreamBandwidthLog.RETENTION_SECONDS;
    while (list.length > 0 && list[0]!.time < cutoffTime) {
      list.shift();
    }

    if (list.length > StreamBandwidthLog.MAX_POINTS_PER_STREAM) {
      list.splice(0, list.length - StreamBandwidthLog.MAX_POINTS_PER_STREAM);
    }
  }

  // Drops streams idle for longer than ttlSec (no points recorded).
  // Returns the evicted ids. Called once per monitor tick.
  public evictIdle(nowSec: number, ttlSec: number = StreamBandwidthLog.IDLE_TTL_SECONDS): string[] {
    const evicted: string[] = [];
    for (const [streamId, seenAt] of this.lastSeen) {
      if (nowSec - seenAt > ttlSec) {
        this.history.delete(streamId);
        this.lastSeen.delete(streamId);
        evicted.push(streamId);
      }
    }
    return evicted;
  }

  public keys(): string[] {
    return [...this.history.keys()];
  }

  public getSince(sinceTime?: number): Record<string, BandwidthPoint[]> {
    const result: Record<string, BandwidthPoint[]> = {};

    for (const [streamId, points] of this.history) {
      if (sinceTime === undefined || sinceTime <= 0) {
        result[streamId] = points.map((p) => ({
          time: p.time,
          inboundBps: p.inboundBps,
          outbounds: { ...p.outbounds },
        }));
      } else {
        const filtered = points.filter((p) => p.time > sinceTime);
        result[streamId] = filtered.map((p) => ({
          time: p.time,
          inboundBps: p.inboundBps,
          outbounds: { ...p.outbounds },
        }));
      }
    }

    return result;
  }

  public clear(): void {
    this.history.clear();
  }
}
