import { describe, expect, test } from "bun:test";
import { mergeStreams } from "../../../src/monitor/grouping/merge-streams";
import type { ConnectionItem, LogicalStreamItem } from "../../../src/web/types";

const item = (overrides: Partial<ConnectionItem> = {}): ConnectionItem => ({
  target: "OUTBOUND",
  health: 100,
  peer_ip: null,
  tx_bps: 0,
  rx_bps: 0,
  bytes_sent: 0,
  bytes_received: 0,
  rtt: 0,
  recv_q: 0,
  send_q: 0,
  drop_percent: 0,
  retrans_total: 0,
  ...overrides,
});

const frame = (streams: LogicalStreamItem[]) => ({ streams });

describe("mergeStreams", () => {
  test("passes through single-protocol streams sorted by id", () => {
    const result = mergeStreams(
      frame([{ id: "b", startedAt: 2, inbound: null, outbound: [item()] }]),
      frame([{ id: "a", startedAt: 1, inbound: null, outbound: [item()] }]),
    );
    expect(result.map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("merges rtmp and srt entries with the same id into one logical stream", () => {
    const srtInbound = item({ target: "INBOUND", protocol: "SRT" });
    const result = mergeStreams(
      frame([
        {
          id: "live",
          startedAt: 2000,
          inbound: null,
          outbound: [item({ target: "VK", protocol: "RTMP" })],
        },
      ]),
      frame([
        {
          id: "live",
          startedAt: 1000,
          inbound: srtInbound,
          outbound: [item({ target: "OUTBOUND", protocol: "SRT" })],
        },
      ]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.inbound).toBe(srtInbound);
    expect(result[0]!.outbound.map((o) => o.protocol)).toEqual(["SRT", "RTMP"]);
    expect(result[0]!.startedAt).toBe(1000);
  });

  test("rtmp inbound fills the gap only when srt has none, and so do tracks", () => {
    const rtmpInbound = item({ target: "INBOUND", protocol: "RTMP" });
    const result = mergeStreams(
      frame([
        {
          id: "live",
          startedAt: 2000,
          inbound: rtmpInbound,
          outbound: [],
          tracks: [{ codec: "avc1" }],
        },
      ]),
      frame([{ id: "live", startedAt: 1000, inbound: null, outbound: [] }]),
    );

    expect(result[0]!.inbound).toBe(rtmpInbound);
    expect(result[0]!.tracks).toEqual([{ codec: "avc1" }]);
  });

  test("handles null snapshots", () => {
    expect(mergeStreams(null, null)).toEqual([]);
    const only = frame([{ id: "a", startedAt: 1, inbound: null, outbound: [] }]);
    expect(mergeStreams(only, null)).toHaveLength(1);
    expect(mergeStreams(null, only)).toHaveLength(1);
  });
});
