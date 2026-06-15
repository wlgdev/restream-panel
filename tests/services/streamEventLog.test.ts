import { expect, test, describe } from "bun:test";
import { StreamEventLog } from "../../src/services/streamEventLog";

describe("StreamEventLog", () => {
  test("push adds events with auto-incrementing seq", () => {
    const log = new StreamEventLog();
    const e1 = log.push({
      timestamp: "2024-01-01T00:00:00Z",
      type: "stream_start",
      protocol: "RTMP",
      streamId: "stream-1",
      target: "INBOUND",
      peerIp: "1.1.1.1",
    });
    const e2 = log.push({
      timestamp: "2024-01-01T00:00:01Z",
      type: "target_connected",
      protocol: "RTMP",
      streamId: "stream-1",
      target: "TWITCH",
      peerIp: "2.2.2.2",
    });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(log.getSince().length).toBe(2);
  });

  test("buffer is capped at 1000 items", () => {
    const log = new StreamEventLog();
    for (let i = 0; i < 1005; i++) {
      log.push({
        timestamp: new Date().toISOString(),
        type: "stream_start",
        protocol: "RTMP",
        streamId: `stream-${i}`,
        target: "INBOUND",
        peerIp: "1.1.1.1",
      });
    }

    const all = log.getSince();
    expect(all.length).toBe(1000);
    expect(all[0].seq).toBe(6);
    expect(all[999].seq).toBe(1005);
  });

  test("getSince without args returns all events", () => {
    const log = new StreamEventLog();
    log.push({ timestamp: "1", type: "stream_start", protocol: "RTMP", streamId: "1", target: "1", peerIp: null });
    log.push({ timestamp: "2", type: "stream_start", protocol: "RTMP", streamId: "1", target: "1", peerIp: null });
    
    expect(log.getSince().length).toBe(2);
  });

  test("getSince(n) returns events after seq n", () => {
    const log = new StreamEventLog();
    log.push({ timestamp: "1", type: "stream_start", protocol: "RTMP", streamId: "1", target: "1", peerIp: null });
    log.push({ timestamp: "2", type: "stream_start", protocol: "RTMP", streamId: "1", target: "1", peerIp: null });
    log.push({ timestamp: "3", type: "stream_start", protocol: "RTMP", streamId: "1", target: "1", peerIp: null });
    
    const after1 = log.getSince(1);
    expect(after1.length).toBe(2);
    expect(after1[0].seq).toBe(2);
    expect(after1[1].seq).toBe(3);

    const after3 = log.getSince(3);
    expect(after3.length).toBe(0);
  });
});
