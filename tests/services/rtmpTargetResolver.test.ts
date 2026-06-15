import { describe, expect, test } from "bun:test";
import { RtmpTargetResolver } from "../../src/services/rtmpTargetResolver";

describe("RtmpTargetResolver", () => {
  test("should detect YouTube by Google org and reuse cached result", async () => {
    let calls = 0;
    const resolver = new RtmpTargetResolver({
      fetcher: async () => {
        calls += 1;
        return {
          ok: true,
          async json() {
            return { org: "AS15169 Google LLC" };
          },
        };
      },
    });

    await expect(resolver.resolveTarget("192.178.183.134")).resolves.toBe("YOUTUBE");
    await expect(resolver.resolveTarget("192.178.183.134")).resolves.toBe("YOUTUBE");
    expect(calls).toBe(1);
  });

  test("should detect VK by org", async () => {
    const resolver = new RtmpTargetResolver({
      fetcher: async () => ({
        ok: true,
        async json() {
          return { org: "VK Cloud Solutions" };
        },
      }),
    });

    await expect(resolver.resolveTarget("185.226.53.80")).resolves.toBe("VK");
  });

  test("should return UNKNOWN on timeout or invalid response", async () => {
    const timeoutResolver = new RtmpTargetResolver({
      timeoutMs: 10,
      fetcher: async (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });

    const invalidResolver = new RtmpTargetResolver({
      fetcher: async () => ({
        ok: true,
        async json() {
          return {};
        },
      }),
    });

    await expect(timeoutResolver.resolveTarget("203.0.113.10")).resolves.toBe("UNKNOWN");
    await expect(invalidResolver.resolveTarget("203.0.113.11")).resolves.toBe("UNKNOWN");
  });
});
