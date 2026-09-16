import { describe, expect, test } from "bun:test";
import { MediamtxCollector } from "../../../src/monitor/collectors/mediamtx-collector";

// Minimal new-shape /metrics: forward_dests carries pos/type and no remoteAddr.
const metricsWithForward = (id: string) => `# Forward destinations
forward_dests{id="${id}",path="test",pos="1",protocol="rtmp",state="forwarding",type="rtmp"} 1
forward_dests_outbound_bytes{id="${id}",path="test",pos="1",protocol="rtmp",state="forwarding",type="rtmp"} 100

# SRT connections
srt_conns{id="srt-1",path="test",remoteAddr="127.0.0.1:5000",state="publish"} 1
srt_conns_ms_rtt{id="srt-1",path="test",remoteAddr="127.0.0.1:5000",state="publish"} 5
`;

describe("MediamtxCollector", () => {
  test("refetches forward details when the forward id changes (reconnect)", async () => {
    let current = metricsWithForward("fwd-A");
    const calls: Array<[string, string]> = [];
    const collector = new MediamtxCollector({
      metricsFetcher: async () => ({ success: true, stdout: current, stderr: "" }),
      pathInfo: {
        forwardFetcher: async (path, id) => {
          calls.push([path, id]);
          // Each forward id dials its own peer, so the map switch proves the old
          // entry was evicted rather than merged.
          const peer = id === "fwd-A" ? "10.0.0.1:1935" : "10.0.0.2:1935";
          return { ok: true, text: `{"typeSpecific":{"remoteAddr":"${peer}"}}` };
        },
      },
    });

    const tick1 = await collector.collect();
    if (!tick1.success) throw new Error("collect failed");
    expect(calls).toEqual([["test", "fwd-A"]]);
    expect(tick1.forwardMap.get("10.0.0.1:1935")).toBe("test");

    // Same id next tick: cached, no refetch.
    await collector.collect();
    expect(calls).toHaveLength(1);

    // Reconnect mints a fresh mediamtx id: refetch, and the old peer drops out.
    current = metricsWithForward("fwd-B");
    const tick3 = await collector.collect();
    if (!tick3.success) throw new Error("collect failed");
    expect(calls).toEqual([
      ["test", "fwd-A"],
      ["test", "fwd-B"],
    ]);
    expect(tick3.forwardMap.get("10.0.0.2:1935")).toBe("test");
    expect(tick3.forwardMap.has("10.0.0.1:1935")).toBe(false);
  });

  test("retries a forward id that first reports no remoteAddr (connecting state)", async () => {
    let calls = 0;
    const collector = new MediamtxCollector({
      metricsFetcher: async () => ({ success: true, stdout: metricsWithForward("fwd-A"), stderr: "" }),
      pathInfo: {
        forwardFetcher: async () => {
          calls += 1;
          // First tick: forward connecting, socket not up yet — no remoteAddr.
          // Second tick: established, addr present. Must heal without restart.
          return calls === 1
            ? { ok: true, text: `{"typeSpecific":{}}` }
            : { ok: true, text: `{"typeSpecific":{"remoteAddr":"10.0.0.1:1935"}}` };
        },
      },
    });

    const tick1 = await collector.collect();
    if (!tick1.success) throw new Error("collect failed");
    expect(tick1.forwardMap.size).toBe(0);

    const tick2 = await collector.collect();
    if (!tick2.success) throw new Error("collect failed");
    expect(calls).toBe(2);
    expect(tick2.forwardMap.get("10.0.0.1:1935")).toBe("test");
  });

  test("leaves the forward map empty when forward details fail, without failing collect", async () => {
    const collector = new MediamtxCollector({
      metricsFetcher: async () => ({ success: true, stdout: metricsWithForward("fwd-A"), stderr: "" }),
      pathInfo: {
        forwardFetcher: async () => ({ ok: false, text: "" }),
      },
    });

    const result = await collector.collect();
    if (!result.success) throw new Error("collect failed");
    expect(result.forwardMap.size).toBe(0);
    expect(result.metrics).toHaveLength(1);
  });

  test("parses connections regardless of label order or presence", async () => {
    const collector = new MediamtxCollector({});

    const raw = collector.parse(`srt_conns{state="publish",remoteAddr="1.2.3.4:5000",path="test",id="x"} 1
srt_conns_ms_rtt{state="publish",path="test",id="x",remoteAddr="1.2.3.4:5000"} 5
`);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ id: "x", path: "test", state: "publish", remoteAddr: "1.2.3.4:5000" });
    expect(raw[0]?.metrics["srt_conns_ms_rtt"]).toBe(5);

    // remoteAddr is deprecated upstream: a connection without one still counts.
    const noAddr = collector.parse(`srt_conns{id="y",path="test",state="publish"} 1\n`);
    expect(noAddr).toHaveLength(1);
    expect(noAddr[0]?.remoteAddr).toBeNull();

    const dests = collector.parseForwardDestinations(
      `forward_dests{type="rtmp",state="forwarding",path="test",pos="1",id="f1",protocol="rtmp"} 1\n`,
    );
    expect(dests).toEqual([{ id: "f1", path: "test", protocol: "rtmp", state: "forwarding" }]);

    const conns = collector.parseRtmpConnections(
      `rtmp_conns{state="publish",path="cloudru",id="p1",remoteAddr="9.9.9.9:1000"} 1\n`,
    );
    expect(conns).toEqual([{ id: "p1", path: "cloudru", remoteAddr: "9.9.9.9:1000", state: "publish" }]);
  });

  test("reads stream start from paths/get availableTime and refetches it on republish", async () => {
    const metricsWithPublishConn = (conn: string) => `# SRT connections
srt_conns{id="${conn}",path="test",remoteAddr="127.0.0.1:5000",state="publish"} 1
srt_conns_ms_rtt{id="${conn}",path="test",remoteAddr="127.0.0.1:5000",state="publish"} 5
`;
    // availableTime wins over the deprecated readyTime.
    const bodies = [
      `{"tracks2":[],"availableTime":"2026-09-06T07:59:32.4044976+03:00","readyTime":"2026-09-06T07:59:30.0000000+03:00"}`,
      `{"tracks2":[],"availableTime":"2026-09-06T08:05:00.0000000+03:00"}`,
    ];
    let i = 0;
    let current = metricsWithPublishConn("srt-A");
    let pathCalls = 0;
    const collector = new MediamtxCollector({
      metricsFetcher: async () => ({ success: true, stdout: current, stderr: "" }),
      pathInfo: {
        pathFetcher: async () => {
          pathCalls += 1;
          return { ok: true, text: bodies[Math.min(i++, bodies.length - 1)]! };
        },
      },
    });

    // collect() never fetches path details itself; the grouping layer follows each
    // tick with ensurePaths, mirrored here.
    await collector.collect();
    await collector.ensurePaths(["test"]);
    expect(pathCalls).toBe(1);
    expect(collector.getStartedAt("test")).toBe(Date.parse("2026-09-06T07:59:32.4044976+03:00"));

    // Same publish connection next tick: cached, no refetch.
    await collector.collect();
    await collector.ensurePaths(["test"]);
    expect(pathCalls).toBe(1);

    // Republish mints a fresh connection id on the same path: the cached details
    // are dropped and the new availableTime is refetched.
    current = metricsWithPublishConn("srt-B");
    await collector.collect();
    await collector.ensurePaths(["test"]);
    expect(pathCalls).toBe(2);
    expect(collector.getStartedAt("test")).toBe(Date.parse("2026-09-06T08:05:00.0000000+03:00"));
    expect(collector.getStartedAt("unknown")).toBeNull();
  });

  test("evicts populated path entries once the path leaves /metrics", async () => {
    const active = `srt_conns{id="srt-1",path="test",remoteAddr="127.0.0.1:5000",state="publish"} 1
`;
    let current = active;
    let pathCalls = 0;
    const collector = new MediamtxCollector({
      metricsFetcher: async () => ({ success: true, stdout: current, stderr: "" }),
      pathInfo: {
        pathFetcher: async () => {
          pathCalls += 1;
          return { ok: true, text: `{"tracks2":[{"codec":"H264"}],"availableTime":"2026-09-06T07:59:32.4044976+03:00"}` };
        },
      },
    });

    await collector.collect();
    await collector.ensurePaths(["test"]);
    expect(pathCalls).toBe(1);

    // Stream ends: the populated entry is dropped so a return refetches fresh data.
    current = `srt_conns 0\n`;
    await collector.collect();
    expect(collector.getStartedAt("test")).toBeNull();

    current = active;
    await collector.collect();
    await collector.ensurePaths(["test"]);
    expect(pathCalls).toBe(2);
    expect(collector.getStartedAt("test")).toBe(Date.parse("2026-09-06T07:59:32.4044976+03:00"));
  });

  test("ignores missing or invalid availability timestamps", async () => {
    const bodies: Record<string, string> = {
      "no-time": `{"tracks2":[]}`,
      "bad-time": `{"tracks2":[],"availableTime":"yesterday-ish"}`,
      "old-server": `{"tracks2":[],"readyTime":"2026-09-06T07:59:30.0000000+03:00"}`,
    };
    const collector = new MediamtxCollector({
      pathInfo: {
        pathFetcher: async (path) => ({ ok: true, text: bodies[path] ?? `{"tracks2":[]}` }),
      },
    });

    await collector.ensurePaths(["no-time", "bad-time", "old-server"]);
    expect(collector.getStartedAt("no-time")).toBeNull();
    expect(collector.getStartedAt("bad-time")).toBeNull();
    // Deprecated readyTime still serves older servers that lack availableTime.
    expect(collector.getStartedAt("old-server")).toBe(Date.parse("2026-09-06T07:59:30.0000000+03:00"));
  });

  test("self-heals an empty track entry once the throttle window elapses", async () => {
    // First fetch races the publisher: the path exists but tracks2 is empty.
    const bodies = [`{"tracks2":[]}`, `{"tracks2":[{"codec":"H264"}]}`];
    let i = 0;
    let clock = 0;
    const collector = new MediamtxCollector({
      now: () => clock,
      pathInfo: {
        pathFetcher: async () => ({ ok: true, text: bodies[Math.min(i++, bodies.length - 1)]! }),
        emptyRefetchIntervalMs: 20000,
      },
    });

    await collector.ensurePaths(["live/a"]);
    expect(collector.getTracks("live/a")).toEqual([]);

    // Within the window — no refetch, entry stays empty.
    clock = 10000;
    await collector.ensurePaths(["live/a"]);
    expect(collector.getTracks("live/a")).toEqual([]);

    // Window elapses — refetch picks up the now-populated tracks.
    clock = 25000;
    await collector.ensurePaths(["live/a"]);
    expect(collector.getTracks("live/a")?.map((t) => t.codec)).toEqual(["H264"]);
  });
});
