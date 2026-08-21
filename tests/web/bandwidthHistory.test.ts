import { describe, expect, it } from "bun:test";
import type { StreamHealthItem } from "../../src/web/types";
import type { BandwidthPoint } from "../../src/web/components/StreamBandwidthChart";

describe("Stream Bandwidth Chart Data Processing", () => {
  it("extracts rx_bps for inbound and tx_bps for outbound targets", () => {
    const inbound: StreamHealthItem = {
      target: "INBOUND",
      protocol: "RTMP",
      health: 100,
      peer_ip: "192.168.1.50:45678",
      rx_bps: 6500000,
      tx_bps: 20000,
      bytes_sent: 500,
      bytes_received: 50000000,
      rtt: 15,
      recv_q: 0,
      send_q: 0,
      drop_percent: 0,
      retrans_total: 0,
    };

    const outbound: StreamHealthItem[] = [
      {
        target: "TWITCH",
        protocol: "RTMPS",
        health: 98,
        peer_ip: "127.0.0.1:19351",
        rx_bps: 5000,
        tx_bps: 6450000,
        bytes_sent: 49000000,
        bytes_received: 1000,
        rtt: 25,
        recv_q: 0,
        send_q: 1200,
        drop_percent: 0.1,
        retrans_total: 2,
      },
      {
        target: "VK",
        protocol: "RTMP",
        health: 100,
        peer_ip: "185.100.10.5:1935",
        rx_bps: 4000,
        tx_bps: 6480000,
        bytes_sent: 49200000,
        bytes_received: 800,
        rtt: 18,
        recv_q: 0,
        send_q: 0,
        drop_percent: 0,
        retrans_total: 0,
      },
    ];

    const timestamp = 1710000000;
    const outboundsRecord: Record<string, number> = {};
    for (const out of outbound) {
      const key = `${out.target}_${out.peer_ip || out.protocol || "dest"}`;
      outboundsRecord[key] = out.tx_bps;
    }

    const point: BandwidthPoint = {
      time: timestamp,
      inboundBps: inbound ? inbound.rx_bps : null,
      outbounds: outboundsRecord,
    };

    expect(point.inboundBps).toBe(6500000);
    expect(point.outbounds["TWITCH_127.0.0.1:19351"]).toBe(6450000);
    expect(point.outbounds["VK_185.100.10.5:1935"]).toBe(6480000);
  });

  it("handles rolling buffer capacity limit correctly for 4 hours (2880 points)", () => {
    const maxPoints = 2880;
    let list: BandwidthPoint[] = [];

    for (let i = 0; i < 3000; i++) {
      const p: BandwidthPoint = {
        time: 1710000000 + i * 5,
        inboundBps: 5000000 + (i % 10) * 100000,
        outbounds: { TWITCH: 4900000 },
      };
      list = [...list, p];
      if (list.length > maxPoints) {
        list = list.slice(list.length - maxPoints);
      }
    }

    expect(list.length).toBe(2880);
    expect(list[0].time).toBe(1710000000 + 120 * 5);
    expect(list[list.length - 1].time).toBe(1710000000 + 2999 * 5);
  });

  it("merges catch-up points without duplicates", () => {
    const initialList: BandwidthPoint[] = [
      { time: 100, inboundBps: 5000, outbounds: {} },
      { time: 105, inboundBps: 5000, outbounds: {} },
      { time: 110, inboundBps: 5000, outbounds: {} },
    ];

    const incomingCatchUp: BandwidthPoint[] = [
      { time: 110, inboundBps: 5000, outbounds: {} }, // duplicate
      { time: 115, inboundBps: 5000, outbounds: {} },
      { time: 120, inboundBps: 5000, outbounds: {} },
    ];

    const existingTimes = new Set(initialList.map((p) => p.time));
    const newPoints = incomingCatchUp.filter((p) => !existingTimes.has(p.time));
    const merged = [...initialList, ...newPoints].sort((a, b) => a.time - b.time);

    expect(merged.length).toBe(5);
    expect(merged.map((p) => p.time)).toEqual([100, 105, 110, 115, 120]);
  });
});

