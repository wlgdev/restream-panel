import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { test_vk } from "../../mocks/ss";
import { srtAndForward1, srtNull } from "../../mocks/srt";
import { StreamBandwidthLog } from "../../src/monitor/bandwidth-log";
import { StreamEventLog } from "../../src/monitor/event-log";
import { RtmpGrouping } from "../../src/monitor/grouping/rtmp-grouping";
import { SrtGrouping } from "../../src/monitor/grouping/srt-grouping";
import { MonitorManager } from "../../src/monitor/monitor-manager";

describe("MonitorManager", () => {
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

  const buildManager = (ssOutput: string, srtOutput: string): MonitorManager => {
    const eventLog = new StreamEventLog();
    const streamBandwidthLog = new StreamBandwidthLog();
    const srtGrouping = new SrtGrouping({
      useMockData: true,
      mockOutputs: [srtOutput],
      eventLog,
      streamBandwidthLog,
    });
    const rtmpGrouping = new RtmpGrouping({
      useMockData: true,
      mockOutputs: [ssOutput],
      forwardMapProvider: () => srtGrouping.getForwardMap(),
      publishMapProvider: () => srtGrouping.getPublishMap(),
      eventLog,
      streamBandwidthLog,
      tracks: srtGrouping,
    });
    return new MonitorManager({ rtmpGrouping, srtGrouping, eventLog, streamBandwidthLog });
  };

  test("tick returns a unified frame with server-merged streams", async () => {
    const manager = buildManager(test_vk, srtAndForward1);
    const snapshot = await manager.tick();

    expect(snapshot.errors).toEqual([]);
    expect(typeof snapshot.timestamp).toBe("string");

    // RTMP VK outbound (forward-correlated to "test") and the SRTLA publish of the
    // same path merge into a single logical stream; SRT wins the inbound slot.
    expect(snapshot.streams).toHaveLength(1);
    const stream = snapshot.streams[0]!;
    expect(stream.id).toBe("test");
    expect(stream.inbound?.protocol).toBe("SRTLA");
    expect(stream.outbound.map((item) => item.protocol)).toEqual(["RTMP"]);
    expect(stream.outbound[0]?.target).toBe("VK");

    expect(snapshot.orphans).toEqual([]);
    expect(snapshot.events.map((event) => event.type)).toEqual(["stream_start", "target_connected"]);

    // Both groupings record the shared "test" id into one log (their ticks land
    // seconds apart under the stepped clock, so points stay separate entries).
    const points = snapshot.bandwidth["test"] ?? [];
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(points.some((point) => point.inboundBps !== null)).toBe(true);
    expect(points.some((point) => Object.keys(point.outbounds).length > 0)).toBe(true);
    expect(manager.getSnapshot()).toEqual(snapshot);
  });

  // A lone outbound with no active stream to associate to (and no forward map)
  // never becomes a stream — it surfaces as an orphan instead.
  const loneOutboundSs = `State             Recv-Q           Send-Q                             Local Address:Port                                  Peer Address:Port           Process
ESTAB             0                256                                 85.92.111.45:36714                                 185.226.53.77:1935            users:(("mediamtx",pid=242385,fd=13)) timer:(on,204ms,0)
         ts sack cubic wscale:7,9 rto:212 rtt:11.281/4.176 ato:40 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:659 bytes_sent:45781628 bytes_acked:45781617 bytes_received:4246 segs_out:35332 segs_in:4594 data_segs_out:35322 data_segs_in:155 send 676700293bps lastsnd:8 lastrcv:390 lastack:9 pacing_rate 1353400584bps delivery_rate 324658616bps delivered:35322 app_limited busy:39174ms unacked:1 rcv_space:14480 rcv_ssthresh:66417 minrtt:8.636 snd_wnd:1000064
`;

  test("routes unassigned connections to orphans, not streams", async () => {
    const snapshot = await buildManager(loneOutboundSs, srtNull).tick();

    expect(snapshot.errors).toEqual([]);
    expect(snapshot.streams).toEqual([]);
    expect(snapshot.orphans).toHaveLength(1);
    expect(snapshot.orphans[0]?.target).toBe("VK");
  });

  test("surfaces collector failures as frame errors", async () => {
    const eventLog = new StreamEventLog();
    const streamBandwidthLog = new StreamBandwidthLog();
    const srtGrouping = new SrtGrouping({
      metricsFetcher: async () => ({ success: false, stdout: "", stderr: "mediamtx down" }),
      eventLog,
      streamBandwidthLog,
    });
    const rtmpGrouping = new RtmpGrouping({
      commandExecutor: () => ({ success: false, stdout: "", stderr: "ss down" }),
      eventLog,
      streamBandwidthLog,
    });
    const snapshot = await new MonitorManager({
      rtmpGrouping,
      srtGrouping,
      eventLog,
      streamBandwidthLog,
    }).tick();

    expect(snapshot.streams).toEqual([]);
    expect(snapshot.orphans).toEqual([]);
    expect(snapshot.errors).toEqual(["mediamtx down", "ss down"]);
  });
});
