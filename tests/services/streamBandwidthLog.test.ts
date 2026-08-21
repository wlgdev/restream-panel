import { expect, test, describe } from "bun:test";
import { StreamBandwidthLog } from "../../src/services/streamBandwidthLog";

describe("StreamBandwidthLog", () => {
  test("records points for streams via recordStreams", () => {
    const log = new StreamBandwidthLog();
    const timestamp = 1710000000;

    log.recordStreams(
      [
        {
          id: "stream-1",
          inbound: {
            target: "INBOUND",
            protocol: "RTMP",
            peer_ip: "10.0.0.1:4000",
            rx_bps: 6500000,
            tx_bps: 0,
          },
          outbound: [
            {
              target: "TWITCH",
              protocol: "RTMPS",
              peer_ip: "127.0.0.1:19351",
              tx_bps: 6400000,
            },
          ],
        },
      ],
      timestamp,
    );

    const history = log.getSince();
    expect(history["stream-1"]).toBeDefined();
    expect(history["stream-1"]?.length).toBe(1);
    expect(history["stream-1"]?.[0]?.time).toBe(1710000000);
    expect(history["stream-1"]?.[0]?.inboundBps).toBe(6500000);
    expect(history["stream-1"]?.[0]?.outbounds["TWITCH_127.0.0.1:19351"]).toBe(6400000);
  });

  test("merges points recorded by different monitors within the same tick", () => {
    const log = new StreamBandwidthLog();
    const timestamp = 1710000000;

    // SRT monitor records inbound first
    log.recordStreams(
      [
        {
          id: "live-stream",
          inbound: {
            target: "INBOUND",
            protocol: "SRT",
            peer_ip: "192.168.1.100:5000",
            rx_bps: 8000000,
            tx_bps: 0,
          },
          outbound: [],
        },
      ],
      timestamp,
    );

    // RTMP monitor records forwarded outbound 1 second later
    log.recordStreams(
      [
        {
          id: "live-stream",
          inbound: null,
          outbound: [
            {
              target: "VK",
              protocol: "RTMP",
              peer_ip: "185.226.53.77:1935",
              tx_bps: 7900000,
            },
          ],
        },
      ],
      timestamp + 1,
    );

    const history = log.getSince();
    expect(history["live-stream"]?.length).toBe(1);
    expect(history["live-stream"]?.[0]?.inboundBps).toBe(8000000);
    expect(history["live-stream"]?.[0]?.outbounds["VK_185.226.53.77:1935"]).toBe(7900000);
  });

  test("getSince without args returns all points in history", () => {
    const log = new StreamBandwidthLog();

    for (let i = 0; i < 5; i++) {
      log.recordPoint("s1", {
        time: 1710000000 + i * 5,
        inboundBps: 5000000,
        outbounds: { TWITCH_dest: 4900000 },
      });
    }

    const all = log.getSince();
    expect(all["s1"]?.length).toBe(5);
  });

  test("getSince(sinceTime) returns only points strictly after sinceTime", () => {
    const log = new StreamBandwidthLog();

    for (let i = 0; i < 6; i++) {
      log.recordPoint("s1", {
        time: 1710000000 + i * 5,
        inboundBps: 5000000 + i * 1000,
        outbounds: { TWITCH_dest: 4900000 },
      });
    }

    // Normal tick query (since previous point at i=4, time=1710000020)
    const single = log.getSince(1710000020);
    expect(single["s1"]?.length).toBe(1);
    expect(single["s1"]?.[0]?.time).toBe(1710000025);

    // Inactive tab catch-up query (since point at i=1, time=1710000005)
    const catchUp = log.getSince(1710000005);
    expect(catchUp["s1"]?.length).toBe(4);
    expect(catchUp["s1"]?.[0]?.time).toBe(1710000010);
    expect(catchUp["s1"]?.[3]?.time).toBe(1710000025);

    // Query with latest timestamp returns 0 points
    const empty = log.getSince(1710000025);
    expect(empty["s1"]?.length).toBe(0);
  });

  test("caps buffer at 2880 points (4 hours) and prunes older points", () => {
    const log = new StreamBandwidthLog();
    const startTime = 1710000000;

    for (let i = 0; i < 3000; i++) {
      log.recordPoint("stream-long", {
        time: startTime + i * 5,
        inboundBps: 6000000,
        outbounds: { TWITCH_1: 5900000 },
      });
    }

    const points = log.getSince()["stream-long"]!;
    expect(points.length).toBe(2880);
    expect(points[0]?.time).toBe(startTime + (3000 - 2880) * 5);
    expect(points[points.length - 1]?.time).toBe(startTime + 2999 * 5);
  });
});
