import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  allMockSsOutputs,
  input,
  input2,
  input3,
  input4_good,
  input5_good,
  input6_good,
  vk_youtube1,
  vk_youtube2,
  vk_youtube3,
} from "../../mocks/ss";
import { StreamMonitor } from "../../src/services/streamMonitor";

const extractStdout = (sample: string | { stdout: string; elapsedMs?: number }): string =>
  typeof sample === "string" ? sample : sample.stdout;

const extractTwitchBytesSent = (sample: string | { stdout: string; elapsedMs?: number }): number => {
  const ssOutput = extractStdout(sample);
  const lines = ssOutput.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes("35.55.17.38:443")) {
      return parseInt(lines[index + 1]?.match(/bytes_sent:(\d+)/)?.[1] ?? "0", 10);
    }
  }

  return 0;
};

describe("StreamMonitor.parse", () => {
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

  test("should parse inbound and outbound sockets from ss output", () => {
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: input2,
        stderr: "",
      }),
    });

    const metrics = monitor.parse(input2);

    expect(metrics).toHaveLength(2);
    expect(metrics.map((item) => item.target)).toEqual(["TWITCH", "INBOUND"]);

    const twitch = metrics.find((item) => item.target === "TWITCH");
    const inbound = metrics.find((item) => item.target === "INBOUND");

    expect(twitch).toMatchObject({
      peer_ip: "35.55.17.38:443",
      pid: 345112,
      send_q: 677860,
      mss: 1448,
      data_segs_out: 16183,
      notsent: 663380,
      tx_bps: 0,
      tx_kernel_bps: 2596145,
      bytes_sent: 23397755,
      is_first_tick: true,
    });

    expect(inbound).toMatchObject({
      local_ip: "194.5.78.216:1935",
      peer_ip: "109.63.168.164:4400",
      pid: 455527,
      recv_q: 0,
      tx_bps: 0,
      tx_kernel_bps: 18658147,
      bytes_received: 51717013,
      is_first_tick: true,
    });
  });

  test("should treat port 1936 as inbound the same way as 1935", () => {
    const monitor = new StreamMonitor();
    const metrics = monitor.parse(`State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:1936                            109.63.168.164:4400               users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
`);

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      target: "INBOUND",
      local_ip: "194.5.78.216:1936",
      peer_ip: "109.63.168.164:4400",
      pid: 455527,
    });
  });

  test("should calculate rates and drop percentage from previous tick", () => {
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: input3,
        stderr: "",
      }),
    });

    monitor.parse(input2);
    const metrics = monitor.parse(input3);

    const twitch = metrics.find((item) => item.target === "TWITCH");
    const inbound = metrics.find((item) => item.target === "INBOUND");

    expect(twitch?.is_first_tick).toBe(false);
    expect(twitch?.drop_percent).toBe(0.99);
    expect(twitch?.tx_bps).toBe(61814541);
    expect(twitch?.rx_bps).toBe(1824);
    expect(twitch?.health).toBe(47);

    expect(inbound?.is_first_tick).toBe(false);
    expect(inbound?.tx_bps).toBe(0);
    expect(inbound?.rx_bps).toBe(142632434);
    expect(inbound?.health).toBe(100);
  });

  test("should penalize sustained outbound backlog even on the first tick", () => {
    const monitor = new StreamMonitor();
    const twitch = monitor.parse(input).find((item) => item.target === "TWITCH");

    expect(twitch?.tx_bps).toBe(0);
    expect(twitch?.tx_kernel_bps).toBe(5930665);
    expect(twitch?.health).toBe(80);
  });

  test("should keep outbound quality at 100 when there is no queue or retransmission pressure", () => {
    const monitor = new StreamMonitor();
    const metrics = monitor.parse(`State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:34584                              35.55.17.38:443                users:(("stunnel4",pid=345112,fd=13))
         ts sack cubic wscale:7,7 rto:241 rtt:40.158/2.79 ato:50 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:9 ssthresh:6 bytes_sent:23397755 bytes_retrans:289600 bytes_acked:23093676 bytes_received:9047 segs_out:16192 segs_in:5700 data_segs_out:16183 data_segs_in:29 send 2596145bps lastsnd:17 lastrcv:1803 lastack:30 pacing_rate 3115368bps delivery_rate 2392640bps delivered:15975 busy:50858ms rwnd_limited:658ms(1.3%) unacked:10 retrans:0/200 lost:1 sacked:1 rcv_space:14480 rcv_ssthresh:31832 notsent:0 minrtt:38 snd_wnd:813312 tcp-ulp-tls rxconf: none txconf: none
`);

    expect(metrics[0]?.health).toBe(100);
  });

  test("should stay close to TwitchTest quality on stable snapshots", () => {
    let now = 1_000_000;
    const monitor = new StreamMonitor({ now: () => now });

    const first = monitor.parse(input4_good).find((item) => item.target === "TWITCH");
    now += 5000;
    const second = monitor.parse(input5_good).find((item) => item.target === "TWITCH");
    now += 5000;
    const third = monitor.parse(input6_good).find((item) => item.target === "TWITCH");

    expect(first?.health).toBe(98);
    expect(second?.health).toBe(98);
    expect(third?.health).toBe(97);
  });
});

describe("StreamMonitor.collectOnce", () => {
  test("should return parsed snapshot from command output", async () => {
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: input2,
        stderr: "",
      }),
    });

    const snapshot = await monitor.collectOnce();

    expect(snapshot.success).toBe(true);
    expect(snapshot.data).toHaveLength(2);
    expect(typeof snapshot.timestamp).toBe("string");
    expect(monitor.getSnapshot()).toEqual(snapshot);
  });

  test("should surface command failures without throwing", async () => {
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: false,
        stdout: "",
        stderr: "permission denied",
        error: "permission denied",
      }),
    });

    const snapshot = await monitor.collectOnce();

    expect(snapshot.success).toBe(false);
    expect(snapshot.data).toEqual([]);
    expect(snapshot.error).toContain("permission denied");
  });

  test("should use random mock output in local dev mode", async () => {
    const monitor = new StreamMonitor({
      useMockData: true,
      mockOutputs: allMockSsOutputs,
      random: () => 0.99,
    });

    const snapshot = await monitor.collectOnce();

    expect(snapshot.success).toBe(true);
    expect(snapshot.data).toHaveLength(3);
    expect(snapshot.data[0]?.bytes_sent).toBe(extractTwitchBytesSent(allMockSsOutputs[0] ?? ""));
  });

  test("should iterate through mock outputs in order before repeating", async () => {
    const monitor = new StreamMonitor({
      useMockData: true,
      mockOutputs: allMockSsOutputs,
      random: () => 0.99,
    });

    const seen: number[] = [];

    for (let index = 0; index < allMockSsOutputs.length; index += 1) {
      const snapshot = await monitor.collectOnce();
      const twitch = snapshot.data.find((item) => item.target === "TWITCH");

      expect(twitch).toBeDefined();
      seen.push(twitch?.bytes_sent ?? -1);
    }

    expect(seen).toEqual(allMockSsOutputs.map((sample) => extractTwitchBytesSent(sample)));
  });

  test("should resolve 1935 RTMP pushes into YouTube and VK targets", async () => {
    const targetByIp: Record<string, "YOUTUBE" | "VK"> = {
      "192.178.183.134": "YOUTUBE",
      "185.226.53.80": "VK",
    };

    let resolverCalls = 0;
    let outputIndex = 0;
    const outputs = [vk_youtube1, vk_youtube2, vk_youtube3];
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: outputs[outputIndex++] ?? outputs[outputs.length - 1]!,
        stderr: "",
      }),
      rtmpTargetResolver: {
        resolveTarget: async (ip) => {
          resolverCalls += 1;
          return targetByIp[ip] ?? "UNKNOWN";
        },
      },
    });

    const first = await monitor.collectOnce();
    const second = await monitor.collectOnce();
    const third = await monitor.collectOnce();

    for (const snapshot of [first, second, third]) {
      expect(snapshot.success).toBe(true);
      expect(snapshot.data.map((item) => item.target)).toEqual(["YOUTUBE", "VK", "INBOUND"]);
      expect(snapshot.streams).toHaveLength(1);
      expect(snapshot.streams[0]?.outbound).toHaveLength(2);
    }

    expect(resolverCalls).toBe(6);
  });

  test("should keep unresolved 1935 pushes as UNKNOWN", async () => {
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: vk_youtube1,
        stderr: "",
      }),
      rtmpTargetResolver: {
        resolveTarget: async () => "UNKNOWN",
      },
    });

    const snapshot = await monitor.collectOnce();
    expect(snapshot.data.map((item) => item.target)).toEqual(["UNKNOWN", "UNKNOWN", "INBOUND"]);
  });

  test("should resolve outbound connections on port 1936 the same as 1935", async () => {
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: `State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   1234                             194.5.78.216:40123                              192.178.183.134:1936            users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_retrans:0 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
ESTAB             0                   0                                194.5.78.216:1936                            109.63.168.164:4400               users:(("nginx",pid=455527,fd=5))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
`,
        stderr: "",
      }),
      rtmpTargetResolver: {
        resolveTarget: async () => "YOUTUBE",
      },
    });

    const snapshot = await monitor.collectOnce();

    expect(snapshot.success).toBe(true);
    expect(snapshot.data.map((item) => item.target)).toEqual(["YOUTUBE", "INBOUND"]);
    expect(snapshot.streams).toHaveLength(1);
  });
});

describe("StreamMonitor client lifecycle", () => {
  test("should collect on first client touch and stop after disconnect", async () => {
    let executorCalls = 0;
    const monitor = new StreamMonitor({
      commandExecutor: () => {
        executorCalls += 1;
        return {
          success: true,
          stdout: input2,
          stderr: "",
        };
      },
      intervalMs: 50,
      clientTtlMs: 100,
    });

    await monitor.touchClient("client-1");
    expect(executorCalls).toBe(1);

    monitor.disconnectClient("client-1");
    monitor.stopAll();
  });
});

describe("StreamMonitor outbound reconnection", () => {
  test("should re-associate reconnected outbound to existing stream when inbound is still alive", async () => {
    let now = 1_000_000;
    let currentOutput = "";
    const monitor = new StreamMonitor({
      now: () => now,
      commandExecutor: () => ({
        success: true,
        stdout: currentOutput,
        stderr: "",
      }),
    });

    // tick 1: inbound + outbound appear together → grouped into one stream
    currentOutput = `State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:1935                            109.63.168.164:5030               users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
ESTAB             0                   33686                            194.5.78.216:42468                              35.55.17.38:443                users:(("stunnel4",pid=345112,fd=13)) timer:(on,073ms,0)
         ts sack cubic wscale:7,7 rto:240 rtt:39.962/2.563 ato:50 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:101 ssthresh:71 bytes_sent:11648642 bytes_retrans:343176 bytes_acked:11271781 bytes_received:8667 segs_out:8490 segs_in:2196 data_segs_out:8482 data_segs_in:20 send 29277414bps lastsnd:14 lastrcv:1212 lastack:9 pacing_rate 35132456bps delivery_rate 26294072bps delivered:8221 busy:11429ms rwnd_limited:661ms(5.8%) unacked:25 retrans:0/237 rcv_space:14480 rcv_ssthresh:31832 minrtt:37.973 snd_wnd:1775488 tcp-ulp-tls rxconf: none txconf: none`;

    const snap1 = await monitor.collectOnce();
    expect(snap1.streams).toHaveLength(1);
    expect(snap1.streams[0]?.outbound).toHaveLength(1);
    const streamId = snap1.streams[0]!.id;

    // tick 2: 30s later outbound reconnects with a new local port, inbound stays
    now += 30_000;

    currentOutput = `State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:1935                            109.63.168.164:5030               users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:50000000 segs_out:20000 segs_in:30000 data_segs_out:8 data_segs_in:29992 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
ESTAB             0                   10000                            194.5.78.216:55555                              35.55.17.38:443                users:(("stunnel4",pid=345112,fd=14)) timer:(on,073ms,0)
         ts sack cubic wscale:7,7 rto:240 rtt:39.962/2.563 ato:50 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:101 ssthresh:71 bytes_sent:500000 bytes_retrans:0 bytes_acked:500000 bytes_received:1000 segs_out:400 segs_in:200 data_segs_out:390 data_segs_in:5 send 29277414bps lastsnd:14 lastrcv:1212 lastack:9 pacing_rate 35132456bps delivery_rate 26294072bps delivered:390 busy:5000ms unacked:2 retrans:0/0 rcv_space:14480 rcv_ssthresh:31832 minrtt:37.973 snd_wnd:1775488 tcp-ulp-tls rxconf: none txconf: none`;

    const snap2 = await monitor.collectOnce();

    // The reconnected outbound should still be in the same logical stream
    expect(snap2.streams).toHaveLength(1);
    expect(snap2.streams[0]?.id).toBe(streamId);
    expect(snap2.streams[0]?.outbound).toHaveLength(1);
    expect(snap2.streams[0]?.outbound[0]?.peer_ip).toBe("35.55.17.38:443");
  });
});

describe("StreamMonitor event generation", () => {
  test("should emit stream_start and target_connected events", async () => {
    let now = 1_000_000;
    const monitor = new StreamMonitor({
      now: () => now,
      commandExecutor: () => ({
        success: true,
        stdout: `State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:1935                            109.63.168.164:5030               users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
ESTAB             0                   0                            194.5.78.216:42468                              35.55.17.38:443                users:(("stunnel4",pid=345112,fd=13)) timer:(on,073ms,0)
         ts sack cubic wscale:7,7 rto:240 rtt:39.962/2.563 ato:50 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:101 ssthresh:71 bytes_sent:11648642 bytes_retrans:343176 bytes_acked:11271781 bytes_received:8667 segs_out:8490 segs_in:2196 data_segs_out:8482 data_segs_in:20 send 29277414bps lastsnd:14 lastrcv:1212 lastack:9 pacing_rate 35132456bps delivery_rate 26294072bps delivered:8221 busy:11429ms rwnd_limited:661ms(5.8%) unacked:25 retrans:0/237 rcv_space:14480 rcv_ssthresh:31832 minrtt:37.973 snd_wnd:1775488 tcp-ulp-tls rxconf: none txconf: none`,
        stderr: "",
      }),
    });

    await monitor.collectOnce();
    const events = monitor.getEventsSince();

    expect(events).toHaveLength(2);
    expect(events.map(e => e.type)).toEqual(["stream_start", "target_connected"]);
    expect(events[0]?.target).toBe("INBOUND");
    expect(events[1]?.target).toBe("TWITCH");
  });

  test("should emit quality_degraded when health < 90 on non-first tick", async () => {
    let currentOutput = "";
    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: currentOutput,
        stderr: "",
      }),
    });

    // Tick 1
    currentOutput = `State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:1935                            109.63.168.164:5030               users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
ESTAB             0                   0                            194.5.78.216:42468                              35.55.17.38:443                users:(("stunnel4",pid=345112,fd=13)) timer:(on,073ms,0)
         ts sack cubic wscale:7,7 rto:240 rtt:39.962/2.563 ato:50 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:101 ssthresh:71 bytes_sent:11648642 bytes_retrans:0 bytes_acked:11271781 bytes_received:8667 segs_out:8490 segs_in:2196 data_segs_out:8482 data_segs_in:20 send 29277414bps lastsnd:14 lastrcv:1212 lastack:9 pacing_rate 35132456bps delivery_rate 26294072bps delivered:8221 busy:11429ms rwnd_limited:661ms(5.8%) unacked:25 retrans:0/0 rcv_space:14480 rcv_ssthresh:31832 minrtt:37.973 snd_wnd:1775488 tcp-ulp-tls rxconf: none txconf: none`;

    await monitor.collectOnce();
    
    // Tick 2 - massive retrans
    currentOutput = `State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:1935                            109.63.168.164:5030               users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
ESTAB             0                   33686                            194.5.78.216:42468                              35.55.17.38:443                users:(("stunnel4",pid=345112,fd=13)) timer:(on,073ms,0)
         ts sack cubic wscale:7,7 rto:240 rtt:39.962/2.563 ato:50 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:101 ssthresh:71 bytes_sent:15000000 bytes_retrans:343176 bytes_acked:11271781 bytes_received:8667 segs_out:8490 segs_in:2196 data_segs_out:18482 data_segs_in:20 send 29277414bps lastsnd:14 lastrcv:1212 lastack:9 pacing_rate 35132456bps delivery_rate 26294072bps delivered:8221 busy:11429ms rwnd_limited:661ms(5.8%) unacked:25 retrans:0/10000 rcv_space:14480 rcv_ssthresh:31832 notsent:100000000 minrtt:37.973 snd_wnd:1775488 tcp-ulp-tls rxconf: none txconf: none`;

    await monitor.collectOnce();
    
    const events = monitor.getEventsSince(2);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type).toBe("quality_degraded");
    expect(events[0]?.metrics).toBeDefined();
    expect(events[0]?.metrics?.health).toBeLessThan(90);
  });

  test("should emit target_disconnected and stream_end when connections close", async () => {
    let currentOutput = `State             Recv-Q              Send-Q                          Local Address:Port                              Peer Address:Port              Process
ESTAB             0                   0                                194.5.78.216:1935                            109.63.168.164:5030               users:(("nginx",pid=455527,fd=4))
         sack cubic wscale:8,7 rto:205 rtt:4.266/0.429 ato:40 mss:1460 pmtu:1500 rcvmss:1460 advmss:1460 cwnd:10 bytes_sent:3482 bytes_acked:3482 bytes_received:11287860 segs_out:3566 segs_in:5036 data_segs_out:8 data_segs_in:5026 send 27379278bps lastsnd:11503 lastrcv:2 lastack:2 pacing_rate 54748928bps delivery_rate 2966720bps delivered:9 app_limited busy:26ms rcv_rtt:4.801 rcv_space:187009 rcv_ssthresh:1359123 minrtt:3.937 rcv_ooopack:12 snd_wnd:65024
ESTAB             0                   0                            194.5.78.216:42468                              35.55.17.38:443                users:(("stunnel4",pid=345112,fd=13)) timer:(on,073ms,0)
         ts sack cubic wscale:7,7 rto:240 rtt:39.962/2.563 ato:50 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:101 ssthresh:71 bytes_sent:11648642 bytes_retrans:0 bytes_acked:11271781 bytes_received:8667 segs_out:8490 segs_in:2196 data_segs_out:8482 data_segs_in:20 send 29277414bps lastsnd:14 lastrcv:1212 lastack:9 pacing_rate 35132456bps delivery_rate 26294072bps delivered:8221 busy:11429ms rwnd_limited:661ms(5.8%) unacked:25 retrans:0/0 rcv_space:14480 rcv_ssthresh:31832 minrtt:37.973 snd_wnd:1775488 tcp-ulp-tls rxconf: none txconf: none`;

    const monitor = new StreamMonitor({
      commandExecutor: () => ({
        success: true,
        stdout: currentOutput,
        stderr: "",
      }),
    });

    await monitor.collectOnce();
    let events = monitor.getEventsSince();
    expect(events).toHaveLength(2);

    // Now empty output
    currentOutput = "";
    await monitor.collectOnce();
    
    events = monitor.getEventsSince(2);
    expect(events).toHaveLength(2);
    
    const types = events.map(e => e.type);
    expect(types).toContain("target_disconnected");
    expect(types).toContain("stream_end");
  });
});
