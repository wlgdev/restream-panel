import { describe, expect, it } from "bun:test";
import type { BandwidthPoint, StreamEvent } from "../../src/web/types";
import {
  MAX_CLIENT_EVENTS,
  mergeBandwidthHistory,
  mergeEventLog,
} from "../../src/web/lib/monitor-merge";

const point = (time: number, inboundBps: number | null = 5000): BandwidthPoint => ({
  time,
  inboundBps,
  outbounds: { TWITCH_dest: 4900 },
});

const event = (seq: number): StreamEvent => ({
  seq,
  timestamp: new Date(1710000000000 + seq * 5000).toISOString(),
  type: "target_connected",
  protocol: "RTMP",
  streamId: "s1",
  target: "VK",
  peerIp: null,
});

describe("mergeBandwidthHistory", () => {
  it("appends fresh points to the local history", () => {
    const prev = { s1: [point(100), point(105)] };
    const next = mergeBandwidthHistory(prev, { s1: [point(110)] }, ["s1"]);

    expect(next["s1"]!.map((p) => p.time)).toEqual([100, 105, 110]);
  });

  it("upserts same-time points from the tail overlap instead of duplicating", () => {
    const prev = { s1: [point(100, 5000)] };
    // Server coalesced a fresher sample into the already-sent t=100 point.
    const next = mergeBandwidthHistory(
      prev,
      { s1: [{ time: 100, inboundBps: 6000, outbounds: { TWITCH_dest: 5900 } }, point(105)] },
      ["s1"],
    );

    expect(next["s1"]!.map((p) => p.time)).toEqual([100, 105]);
    expect(next["s1"]![0]!.inboundBps).toBe(6000);
    expect(next["s1"]![0]!.outbounds["TWITCH_dest"]).toBe(5900);
  });

  it("keeps the old inbound value when the overlap refresh carries null", () => {
    const prev = { s1: [point(100, 5000)] };
    const next = mergeBandwidthHistory(
      prev,
      { s1: [{ time: 100, inboundBps: null, outbounds: { VK_dest: 100 } }] },
      ["s1"],
    );

    expect(next["s1"]![0]!.inboundBps).toBe(5000);
    expect(next["s1"]![0]!.outbounds).toEqual({ TWITCH_dest: 4900, VK_dest: 100 });
  });

  it("adds brand-new streams from the delta", () => {
    const next = mergeBandwidthHistory({}, { s2: [point(200)] }, ["s2"]);

    expect(next["s2"]!.map((p) => p.time)).toEqual([200]);
  });

  it("drops streams missing from the server key list (evicted idle)", () => {
    const prev = { s1: [point(100)], s2: [point(100)] };
    const next = mergeBandwidthHistory(prev, { s1: [point(105)] }, ["s1"]);

    expect(Object.keys(next).sort()).toEqual(["s1"]);
    expect(next["s1"]!.map((p) => p.time)).toEqual([100, 105]);
  });

  it("does not mutate the previous state", () => {
    const prev = { s1: [point(100)] };
    mergeBandwidthHistory(prev, { s1: [point(105)] }, ["s1"]);

    expect(prev["s1"]!.length).toBe(1);
  });
});

describe("mergeEventLog", () => {
  it("appends fresh events and skips retransmitted tail", () => {
    const prev = [event(1), event(2)];
    const next = mergeEventLog(prev, [event(2), event(3)]);

    expect(next.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("returns the previous log untouched when the delta is empty", () => {
    const prev = [event(1)];
    expect(mergeEventLog(prev, [])).toBe(prev);
  });

  it("trims the buffer to the server cap", () => {
    const prev = Array.from({ length: MAX_CLIENT_EVENTS }, (_, i) => event(i + 1));
    const next = mergeEventLog(prev, [event(MAX_CLIENT_EVENTS + 1)]);

    expect(next.length).toBe(MAX_CLIENT_EVENTS);
    expect(next[0]!.seq).toBe(2);
    expect(next[next.length - 1]!.seq).toBe(MAX_CLIENT_EVENTS + 1);
  });
});
