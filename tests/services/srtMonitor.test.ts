import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { srt1, srt2, srt3, srtNull } from "../../mocks/srt";
import { SrtMonitor } from "../../src/services/srtMonitor";

const extractMetric = (sample: string, metric: string, state: "publish" | "read"): number => {
  const match = sample.match(new RegExp(`${metric}\\{[^}]*state="${state}"[^}]*\\}\\s+([0-9.\\-e+]+)`));
  return match?.[1] ? parseFloat(match[1]) : 0;
};

describe("SrtMonitor", () => {
  const realDateNow = Date.now;

  beforeEach(() => {
    let now = 1_000_000;
    let calls = 0;

    Date.now = () => {
      calls += 1;
      if (calls % 2 === 1) {
        now += 5000;
      }
      return now;
    };
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  test("should parse inbound and outbound connections from MediaMTX SRT metrics", async () => {
    const monitor = new SrtMonitor({
      metricsFetcher: async () => ({
        success: true,
        stdout: srt1,
        stderr: "",
      }),
    });

    const snapshot = await monitor.collectOnce();

    expect(snapshot.data).toHaveLength(2);
    expect(snapshot.streams).toHaveLength(1);

    const inbound = snapshot.data.find((item) => item.target === "INBOUND");
    const outbound = snapshot.data.find((item) => item.target === "OUTBOUND");

    expect(inbound).toBeDefined();
    expect(inbound?.protocol).toBe("SRT");
    expect(inbound?.stream_id).toBe("irl");
    expect(inbound?.peer_ip).toBe("109.63.168.164:62573");
    expect(inbound?.rx_bps).toBe(0);
    expect(inbound?.rtt_jitter).toBe(0);
    expect(inbound?.recv_buffer_ms).toBe(3009);
    expect(inbound?.health).toBe(100);

    expect(outbound).toBeDefined();
    expect(outbound?.stream_id).toBe("irl");
    expect(outbound?.peer_ip).toBe("109.63.168.164:60484");
    expect(outbound?.tx_bps).toBe(0);
    expect(outbound?.rtt_jitter).toBe(0);
    expect(outbound?.send_buffer_ms).toBe(0);
    expect(outbound?.health).toBe(100);
  });

  test("should degrade health when loss, drops and buffering increase across ticks", async () => {
    const mockOutputs = [srt1, srt2, srt3, srtNull];
    let idx = 0;

    const monitor = new SrtMonitor({
      metricsFetcher: async () => ({
        success: true,
        stdout: mockOutputs[idx++]!,
        stderr: "",
      }),
    });

    const tick1 = await monitor.collectOnce();
    const tick1Inbound = tick1.data.find((item) => item.target === "INBOUND");
    const tick1Outbound = tick1.data.find((item) => item.target === "OUTBOUND");
    expect(tick1Inbound?.health).toBe(100);
    expect(tick1Outbound?.health).toBe(100);

    const tick2 = await monitor.collectOnce();
    const tick2Inbound = tick2.data.find((item) => item.target === "INBOUND");
    const tick2Outbound = tick2.data.find((item) => item.target === "OUTBOUND");
    expect(tick2Inbound?.drop_percent).toBe(0);
    expect(tick2Inbound?.rx_bps).toBeGreaterThan(0);
    expect(tick2Outbound?.tx_bps).toBeGreaterThan(0);
    expect(tick2Inbound?.rtt_jitter).toBeGreaterThanOrEqual(0);
    expect(tick2Outbound?.rtt_jitter).toBeGreaterThanOrEqual(0);
    expect(tick2Inbound?.health).toBeGreaterThanOrEqual(98);
    expect(tick2Outbound?.health).toBeGreaterThanOrEqual(98);

    const tick3 = await monitor.collectOnce();
    const tick3Inbound = tick3.data.find((item) => item.target === "INBOUND");
    const tick3Outbound = tick3.data.find((item) => item.target === "OUTBOUND");
    expect(tick3Inbound).toBeDefined();
    expect(tick3Outbound).toBeDefined();
    expect(tick3Inbound!.rtt_jitter).toBeGreaterThanOrEqual(tick2Inbound!.rtt_jitter ?? 0);
    expect(tick3Inbound!.health).toBeLessThan(tick2Inbound!.health);
    expect(tick3Outbound!.health).toBeLessThanOrEqual(tick2Outbound!.health);
    expect(tick3Inbound!.retrans_total).toBeGreaterThanOrEqual(tick2Inbound!.retrans_total);

    const tick4 = await monitor.collectOnce();
    expect(tick4.success).toBe(true);
    expect(tick4.data).toHaveLength(0);
    expect(tick4.streams).toHaveLength(0);
  });

  test("should iterate through mock outputs in order in local dev mode", async () => {
    const monitor = new SrtMonitor({
      useMockData: true,
      mockOutputs: [srt1, srt2, srt3],
    });

    const seenInboundBytes: number[] = [];

    for (let index = 0; index < 3; index += 1) {
      const snapshot = await monitor.collectOnce();
      const inbound = snapshot.data.find((item) => item.target === "INBOUND");
      seenInboundBytes.push(inbound?.bytes_received ?? -1);
    }

    expect(seenInboundBytes).toEqual([
      extractMetric(srt1, "srt_conns_bytes_received", "publish"),
      extractMetric(srt2, "srt_conns_bytes_received", "publish"),
      extractMetric(srt3, "srt_conns_bytes_received", "publish"),
    ]);
  });
});
