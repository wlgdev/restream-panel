import { describe, test, expect } from "bun:test";
import { generateNginxConfig, generateDefaultConfig } from "../../src/core/writer";
import { parseNginxConfig } from "../../src/core/parser";
import type { NginxConfig } from "../../src/core/types";

const createTestConfig = (): NginxConfig => ({
  applications: [
    {
      name: "twitch_stockholm",
      isProtected: true,
      pushTargets: [
        {
          server: {
            id: "twitch_stockholm",
            name: "Twitch Stockholm",
            url: "rtmp://127.0.0.1:19351/app",
            requiresStreamKey: true,
          },
          streamKey: "",
        },
      ],
    },
    {
      name: "my_stream",
      isProtected: false,
      pushTargets: [
        {
          server: {
            id: "twitch_frankfurt",
            name: "Twitch Frankfurt",
            url: "rtmp://127.0.0.1:19352/app",
            requiresStreamKey: true,
          },
          streamKey: "my_twitch_key",
        },
        {
          server: {
            id: "vk",
            name: "VK",
            url: "rtmp://vsu.mycdn.me/input",
            requiresStreamKey: true,
          },
          streamKey: "my_vk_key",
        },
        {
          server: {
            id: "youtube",
            name: "YouTube",
            url: "rtmp://a.rtmp.youtube.com/live2",
            requiresStreamKey: true,
            supportsDynamicStreamKey: true,
          },
          streamKey: "my_youtube_key",
        },
      ],
    },
  ],
  streamTargets: [{ id: "twitch_failover_proxy" }],
  headerContent: `user www-data;
worker_processes 1;

events {
    worker_connections 768;
}
`,
  footerContent: "",
  stunnelComments: `        # stunnel 19351 - Twitch Stockholm
        # stunnel 19352 - Twitch Frankfurt
        # stunnel 19353 - Twitch Paris`,
});

describe("generateNginxConfig", () => {
  test("should generate valid nginx config", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.success).toBe(true);
    expect(result.content).toBeDefined();
  });

  test("should include header content", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.content).toContain("user www-data");
    expect(result.content).toContain("worker_connections 768");
  });

  test("should include rtmp block", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.content).toContain("rtmp {");
    expect(result.content).toContain("stream {");
    expect(result.content).toContain("server {");
  });

  test("should include failover tcp proxy block", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.content).toContain("listen 1936;");
    expect(result.content).toContain("proxy_pass 127.0.0.1:19360;");
    expect(result.content).toContain("proxy_connect_timeout 5s;");
    expect(result.content).toContain("proxy_timeout 15s;");
  });

  test("should generate application blocks", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.content).toContain("application twitch_stockholm");
    expect(result.content).toContain("application my_stream");
  });

  test("should generate push directives correctly", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.content).toContain("push rtmp://127.0.0.1:19351/app;");
    expect(result.content).toContain("push rtmp://127.0.0.1:19352/app/my_twitch_key;");
    expect(result.content).toContain("push rtmp://vsu.mycdn.me/input/my_vk_key;");
    expect(result.content).toContain("push rtmp://a.rtmp.youtube.com/live2/my_youtube_key;");
  });

  test("should generate youtube push without stream key for dynamic single-target apps", () => {
    const config = createTestConfig();
    config.applications.push({
      name: "youtube_dynamic",
      isProtected: false,
      pushTargets: [
        {
          server: {
            id: "youtube",
            name: "YouTube",
            url: "rtmp://a.rtmp.youtube.com/live2",
            requiresStreamKey: true,
            supportsDynamicStreamKey: true,
          },
          streamKey: "",
        },
      ],
    });

    const result = generateNginxConfig(config);

    expect(result.content).toContain("application youtube_dynamic");
    expect(result.content).toContain("push rtmp://a.rtmp.youtube.com/live2;");
  });

  test("should include live on and record off", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.content).toContain("live on;");
    expect(result.content).toContain("record off;");
  });

  test("should add comment for protected applications", () => {
    const config = createTestConfig();
    const result = generateNginxConfig(config);

    expect(result.content).toContain("# Twitch Stockholm");
  });
});

describe("generateDefaultConfig", () => {
  test("should generate default config with all protected applications", () => {
    const content = generateDefaultConfig();

    expect(content).toContain("application twitch_stockholm");
    expect(content).toContain("application twitch_frankfurt");
    expect(content).toContain("application twitch_paris");
    expect(content).toContain("application vk");
    expect(content).toContain("application youtube");
  });

  test("should generate vk with VK push target", () => {
    const content = generateDefaultConfig();

    expect(content).toContain("# Vk");
    expect(content).toContain("push rtmp://vsu.mycdn.me/input;");
  });

  test("should generate youtube with youtube push target", () => {
    const content = generateDefaultConfig();

    expect(content).toContain("# Youtube");
    expect(content).toContain("push rtmp://a.rtmp.youtube.com/live2;");
  });

  test("should generate valid nginx structure", () => {
    const content = generateDefaultConfig();

    expect(content).toContain("rtmp {");
    expect(content).toContain("stream {");
    expect(content).toContain("server {");
    expect(content).toContain("listen 1935");
    expect(content).toContain("listen 1936");
    expect(content).toContain("chunk_size 4096");
  });

  test("should generate parseable config", () => {
    const content = generateDefaultConfig();
    const result = parseNginxConfig(content);

    expect(result.success).toBe(true);
    expect(result.config?.applications).toHaveLength(6);
    expect(result.config?.streamTargets).toEqual([{ id: "twitch_failover_proxy" }]);
    expect(result.config?.applications.every((a) => a.isProtected)).toBe(true);
  });
});

describe("round-trip: parse then generate", () => {
  test("should be idempotent for simple config", () => {
    const originalConfig = `user www-data;
worker_processes 1;

events {
    worker_connections 768;
}

rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        # stunnel 19351 - Twitch Stockholm

        # Twitch Stockholm
        application twitch_stockholm {
            live on;
            record off;

            push rtmp://127.0.0.1:19351/app;
        }
    }
}

stream {
    server {
        listen 1936;

        proxy_pass 127.0.0.1:19360;

        proxy_connect_timeout 5s;
        proxy_timeout 15s;
    }
}
`;

    const parseResult = parseNginxConfig(originalConfig);
    expect(parseResult.success).toBe(true);

    if (parseResult.success && parseResult.config) {
      const generateResult = generateNginxConfig(parseResult.config);
      expect(generateResult.success).toBe(true);

      const secondParseResult = parseNginxConfig(generateResult.content || "");
      expect(secondParseResult.success).toBe(true);

      if (secondParseResult.success && secondParseResult.config) {
        expect(secondParseResult.config.applications).toHaveLength(1);
        expect(secondParseResult.config.applications[0]?.name).toBe("twitch_stockholm");
        expect(secondParseResult.config.streamTargets).toEqual([{ id: "twitch_failover_proxy" }]);
      }
    }
  });

  test("should preserve application names after round-trip", () => {
    const config = createTestConfig();
    const generateResult = generateNginxConfig(config);
    expect(generateResult.success).toBe(true);

    if (generateResult.content) {
      const parseResult = parseNginxConfig(generateResult.content);
      expect(parseResult.success).toBe(true);

      if (parseResult.success && parseResult.config) {
        const names = parseResult.config.applications.map((a) => a.name);
        expect(names).toContain("twitch_stockholm");
        expect(names).toContain("my_stream");
      }
    }
  });

  test("should preserve push targets after round-trip", () => {
    const config = createTestConfig();
    const generateResult = generateNginxConfig(config);
    expect(generateResult.success).toBe(true);

    if (generateResult.content) {
      const parseResult = parseNginxConfig(generateResult.content);
      expect(parseResult.success).toBe(true);

      if (parseResult.success && parseResult.config) {
        const myStream = parseResult.config.applications.find((a) => a.name === "my_stream");
        expect(myStream?.pushTargets).toHaveLength(3);

        const twitchTarget = myStream?.pushTargets.find((t) => t.server.id === "twitch_frankfurt");
        expect(twitchTarget?.streamKey).toBe("my_twitch_key");

        const vkTarget = myStream?.pushTargets.find((t) => t.server.id === "vk");
        expect(vkTarget?.streamKey).toBe("my_vk_key");

        const youtubeTarget = myStream?.pushTargets.find((t) => t.server.id === "youtube");
        expect(youtubeTarget?.streamKey).toBe("my_youtube_key");
      }
    }
  });
});
