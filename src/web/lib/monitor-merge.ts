import type { BandwidthPoint, StreamEvent } from "../types";

// Mirrors the server-side StreamEventLog cap: the client buffer must not grow
// past it, since delta frames only ever append.
export const MAX_CLIENT_EVENTS = 1000;

// Merges a delta bandwidth frame into the local full history. Points upsert
// by time: the server re-sends a small tail overlap because recordPoint may
// mutate an already-sent point in place (2s coalescing), so same-time points
// refresh rather than duplicate.
export function mergeBandwidthHistory(
  prev: Record<string, BandwidthPoint[]>,
  delta: Record<string, BandwidthPoint[]>,
  liveKeys: string[],
): Record<string, BandwidthPoint[]> {
  const next: Record<string, BandwidthPoint[]> = { ...prev };

  for (const [streamId, points] of Object.entries(delta)) {
    if (points.length === 0) continue;
    const list = next[streamId] !== undefined ? [...next[streamId]!] : [];
    const indexByTime = new Map<number, number>();
    for (let i = 0; i < list.length; i++) {
      indexByTime.set(list[i]!.time, i);
    }

    for (const point of points) {
      const idx = indexByTime.get(point.time);
      if (idx === undefined) {
        indexByTime.set(point.time, list.length);
        list.push({
          time: point.time,
          inboundBps: point.inboundBps,
          outbounds: { ...point.outbounds },
        });
      } else {
        const existing = list[idx]!;
        list[idx] = {
          time: point.time,
          // A null inbound means "no update" (coalesced tail refresh), not
          // "inbound gone" — fresh points always carry the full value.
          inboundBps: point.inboundBps !== null ? point.inboundBps : existing.inboundBps,
          outbounds: { ...existing.outbounds, ...point.outbounds },
        };
      }
    }

    list.sort((a, b) => a.time - b.time);
    next[streamId] = list;
  }

  // Drop streams the server evicted (finished long ago); their absence from a
  // delta is "no new data", so only the explicit key list signals death.
  const live = new Set(liveKeys);
  for (const streamId of Object.keys(next)) {
    if (!live.has(streamId)) {
      delete next[streamId];
    }
  }

  return next;
}

// Appends fresh events, skipping retransmits from the tail overlap, and trims
// to the server buffer cap.
export function mergeEventLog(prev: StreamEvent[], delta: StreamEvent[]): StreamEvent[] {
  if (delta.length === 0) return prev;
  const lastSeq = prev.length > 0 ? prev[prev.length - 1]!.seq : 0;
  const fresh = delta.filter((event) => event.seq > lastSeq);
  if (fresh.length === 0) return prev;

  const merged = [...prev, ...fresh];
  return merged.length > MAX_CLIENT_EVENTS
    ? merged.slice(merged.length - MAX_CLIENT_EVENTS)
    : merged;
}
