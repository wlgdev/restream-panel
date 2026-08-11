import { expect, test, describe } from "bun:test";
import { PathInfoService } from "../../src/services/pathInfoService";

// A mutable script of /v3/paths/list bodies the service returns on each real fetch, so a
// test can simulate mediamtx populating tracks2 after the first (racy, empty) fetch.
function scriptedFetcher(bodies: string[]) {
  let i = 0;
  return async () => {
    const text = bodies[Math.min(i, bodies.length - 1)] ?? '{"items":[]}';
    i += 1;
    return { ok: true, text } as const;
  };
}

describe("PathInfoService", () => {
  test("first fetch caches tracks when mediamtx already has them", async () => {
    const svc = new PathInfoService({
      fetcher: scriptedFetcher([
        JSON.stringify({ items: [{ name: "live/a", tracks2: [{ codec: "H264" }] }] }),
      ]),
    });

    await svc.ensurePaths(["live/a"]);
    expect(svc.getTracks("live/a")?.map((t) => t.codec)).toEqual(["H264"]);
  });

  test("self-heals an empty entry once the throttle window elapses", async () => {
    // First fetch races the publisher: the path exists but tracks2 is empty.
    const bodies = [
      JSON.stringify({ items: [{ name: "live/a", tracks2: [] }] }),
      // Second fetch, after the window, mediamtx has parsed the codec.
      JSON.stringify({ items: [{ name: "live/a", tracks2: [{ codec: "H264" }] }] }),
    ];
    let clock = 0;
    const svc = new PathInfoService({
      fetcher: scriptedFetcher(bodies),
      emptyRefetchIntervalMs: 20000,
      now: () => clock,
    });

    await svc.ensurePaths(["live/a"]);
    expect(svc.getTracks("live/a")).toEqual([]);

    // Within the window — no refetch, entry stays empty.
    clock = 10000;
    await svc.ensurePaths(["live/a"]);
    expect(svc.getTracks("live/a")).toEqual([]);

    // Window elapses — refetch picks up the now-populated tracks.
    clock = 25000;
    await svc.ensurePaths(["live/a"]);
    expect(svc.getTracks("live/a")?.map((t) => t.codec)).toEqual(["H264"]);
  });

  test("a non-empty entry never triggers a refetch", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return {
        ok: true,
        text: JSON.stringify({ items: [{ name: "live/a", tracks2: [{ codec: "H264" }] }] }),
      } as const;
    };
    let clock = 0;
    const svc = new PathInfoService({
      fetcher,
      emptyRefetchIntervalMs: 20000,
      now: () => clock,
    });

    await svc.ensurePaths(["live/a"]);
    expect(calls).toBe(1);

    // Long after the window — still no refetch because the entry is non-empty.
    clock = 100000;
    await svc.ensurePaths(["live/a"]);
    await svc.ensurePaths(["live/a"]);
    expect(calls).toBe(1);
    expect(svc.getTracks("live/a")?.map((t) => t.codec)).toEqual(["H264"]);
  });

  test("a newly-seen path forces a fetch even within the window", async () => {
    let calls = 0;
    // First response lists only live/a; live/b appears later (a publisher joined mediamtx).
    let body = JSON.stringify({ items: [{ name: "live/a", tracks2: [{ codec: "H264" }] }] });
    const fetcher = async () => {
      calls += 1;
      const text = body;
      // Second fetch onward sees live/b too.
      body = JSON.stringify({
        items: [
          { name: "live/a", tracks2: [{ codec: "H264" }] },
          { name: "live/b", tracks2: [{ codec: "Opus" }] },
        ],
      });
      return { ok: true, text } as const;
    };
    let clock = 0;
    const svc = new PathInfoService({
      fetcher,
      emptyRefetchIntervalMs: 20000,
      now: () => clock,
    });

    await svc.ensurePaths(["live/a"]);
    expect(calls).toBe(1);
    expect(svc.getTracks("live/b")).toBeUndefined();

    // live/b is new — fetch fires immediately despite the window not having elapsed.
    clock = 5000;
    await svc.ensurePaths(["live/b"]);
    expect(calls).toBe(2);
    expect(svc.getTracks("live/b")?.map((t) => t.codec)).toEqual(["Opus"]);
  });

  test("concurrent callers coalesce onto one in-flight fetch", async () => {
    let calls = 0;
    let resolve: ((value: { ok: boolean; text: string }) => void) | null = null;
    const fetcher = () =>
      new Promise<{ ok: boolean; text: string }>((res) => {
        calls += 1;
        resolve = res;
      });
    const svc = new PathInfoService({ fetcher });

    const p1 = svc.ensurePaths(["live/a"]);
    const p2 = svc.ensurePaths(["live/a"]);
    expect(calls).toBe(1);

    resolve!({ ok: true, text: JSON.stringify({ items: [{ name: "live/a", tracks2: [{ codec: "H264" }] }] }) });
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(svc.getTracks("live/a")?.map((t) => t.codec)).toEqual(["H264"]);
  });
});
