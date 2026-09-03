import type { Track } from "../../core/types";

// Any logical stream shape with an id, an inbound slot and an outbound list.
// Satisfied by the monitor's LogicalStream as well as the frontend's item type,
// so the merge invariant is shared instead of re-implemented per layer.
export interface MergableStream<Inbound, Outbound> {
  id: string;
  startedAt: number;
  inbound: Inbound | null;
  outbound: Outbound[];
  tracks?: Track[];
}

// Merges the RTMP and SRT groupings into one logical-stream list, keyed by stream id.
// SRT wins on conflicts (inbound) — RTMP only fills gaps. StartedAt takes the
// earliest of the two so uptime survives a protocol handover.
export function mergeStreams<Stream extends MergableStream<unknown, unknown>>(
  rtmp: { streams: Stream[] } | null,
  srt: { streams: Stream[] } | null,
): Stream[] {
  const map = new Map<string, Stream>();

  if (srt) {
    for (const s of srt.streams) {
      map.set(s.id, {
        id: s.id,
        startedAt: s.startedAt,
        inbound: s.inbound,
        outbound: [...s.outbound],
        tracks: s.tracks,
      } as Stream);
    }
  }

  if (rtmp) {
    for (const s of rtmp.streams) {
      if (map.has(s.id)) {
        const existing = map.get(s.id)!;
        existing.outbound.push(...s.outbound);
        if (!existing.inbound && s.inbound) {
          existing.inbound = s.inbound;
        }
        existing.startedAt = Math.min(existing.startedAt, s.startedAt);
        if (!existing.tracks?.length && s.tracks?.length) {
          existing.tracks = s.tracks;
        }
      } else {
        map.set(s.id, {
          id: s.id,
          startedAt: s.startedAt,
          inbound: s.inbound,
          outbound: [...s.outbound],
          tracks: s.tracks,
        } as Stream);
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}
