import { describe, test, expect } from "bun:test";
import { parseNginxConfig, getApplicationByName, applicationNameExists } from "../../src/core/parser";

// Sample nginx.conf content for testing
const SAMPLE_CONFIG = `user www-data;
worker_processes 1;

pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        # stunnel 19351 - Twitch Stockholm
        # stunnel 19352 - Twitch Frankfurt
        # stunnel 19353 - Twitch Paris

        # Twitch Stockholm
        application twitch_stockholm {
            live on;
            record off;

            push rtmp://127.0.0.1:19351/app;
        }

        # Twitch Frankfurt
        application twitch_frankfurt {
            live on;
            record off;

            push rtmp://127.0.0.1:19352/app;
        }

        # Twitch Paris
        application twitch_paris {
            live on;
            record off;

            push rtmp://127.0.0.1:19353/app;
        }

        # Vk
        application vk {
            live on;
            record off;

            push rtmp://vsu.mycdn.me/input;
        }

        # Youtube
        application youtube {
            live on;
            record off;

            push rtmp://a.rtmp.youtube.com/live2;
        }
    }
}
`;

const CONFIG_WITH_CUSTOM_APPS = `user www-data;
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

        # Custom application
        application my_stream {
            live on;
            record off;

            push rtmp://127.0.0.1:19351/app/my_stream_key;
            push rtmp://vsu.mycdn.me/input/vk_key_123;
            push rtmp://a.rtmp.youtube.com/live2/youtube_key_456;
        }
    }
}
`;

const SAMPLE_CONFIG_WITH_STREAM_PROXY = `user www-data;
worker_processes 1;

events {
    worker_connections 768;
}

rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        application twitch_failover {
            live on;
            record off;

            push rtmp://127.0.0.1:19360/app;
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

describe("parseNginxConfig", () => {
  test("should parse config with protected applications", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    expect(result.success).toBe(true);
    expect(result.config).toBeDefined();
    expect(result.config?.applications).toHaveLength(5);
  });

  test("should identify protected applications correctly", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    expect(result.success).toBe(true);

    const stockholm = result.config?.applications.find((a) => a.name === "twitch_stockholm");
    const frankfurt = result.config?.applications.find((a) => a.name === "twitch_frankfurt");
    const paris = result.config?.applications.find((a) => a.name === "twitch_paris");
    const vk = result.config?.applications.find((a) => a.name === "vk");
    const youtube = result.config?.applications.find((a) => a.name === "youtube");

    expect(stockholm?.isProtected).toBe(true);
    expect(frankfurt?.isProtected).toBe(true);
    expect(paris?.isProtected).toBe(true);
    expect(vk?.isProtected).toBe(true);
    expect(youtube?.isProtected).toBe(true);
  });

  test("should parse vk push target correctly", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    expect(result.success).toBe(true);

    const vk = result.config?.applications.find((a) => a.name === "vk");
    expect(vk).toBeDefined();
    expect(vk?.pushTargets).toHaveLength(1);
    expect(vk?.pushTargets[0]?.server.id).toBe("vk");
    expect(vk?.pushTargets[0]?.streamKey).toBe("");
  });

  test("should parse youtube protected push target correctly", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    expect(result.success).toBe(true);

    const youtube = result.config?.applications.find((a) => a.name === "youtube");
    expect(youtube).toBeDefined();
    expect(youtube?.isProtected).toBe(true);
    expect(youtube?.pushTargets).toHaveLength(1);
    expect(youtube?.pushTargets[0]?.server.id).toBe("youtube");
    expect(youtube?.pushTargets[0]?.streamKey).toBe("");
  });

  test("should parse config with custom applications", () => {
    const result = parseNginxConfig(CONFIG_WITH_CUSTOM_APPS);

    expect(result.success).toBe(true);
    expect(result.config?.applications).toHaveLength(2);

    const customApp = result.config?.applications.find((a) => a.name === "my_stream");
    expect(customApp).toBeDefined();
    expect(customApp?.isProtected).toBe(false);
  });

  test("should parse push directives with stream keys", () => {
    const result = parseNginxConfig(CONFIG_WITH_CUSTOM_APPS);

    expect(result.success).toBe(true);

    const customApp = result.config?.applications.find((a) => a.name === "my_stream");
    expect(customApp?.pushTargets).toHaveLength(3);

    const twitchTarget = customApp?.pushTargets.find((t) => t.server.id === "twitch_stockholm");
    expect(twitchTarget?.streamKey).toBe("my_stream_key");

    const vkTarget = customApp?.pushTargets.find((t) => t.server.id === "vk");
    expect(vkTarget?.streamKey).toBe("vk_key_123");

    const youtubeTarget = customApp?.pushTargets.find((t) => t.server.id === "youtube");
    expect(youtubeTarget?.streamKey).toBe("youtube_key_456");
  });

  test("should parse youtube push target without stream key", () => {
    const configWithDynamicYoutube = `rtmp {
    server {
        listen 1935;
        chunk_size 4096;

        application youtube_dynamic {
            live on;
            record off;

            push rtmp://a.rtmp.youtube.com/live2;
        }
    }
}`;

    const result = parseNginxConfig(configWithDynamicYoutube);

    expect(result.success).toBe(true);

    const app = result.config?.applications.find((a) => a.name === "youtube_dynamic");
    expect(app?.pushTargets).toHaveLength(1);
    expect(app?.pushTargets[0]?.server.id).toBe("youtube");
    expect(app?.pushTargets[0]?.streamKey).toBe("");
  });

  test("should handle malformed config gracefully", () => {
    const result = parseNginxConfig("invalid config");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("should return error for config without rtmp block", () => {
    const result = parseNginxConfig("user www-data;\nworker_processes 1;");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No rtmp block");
  });

  test("should preserve header content", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    expect(result.success).toBe(true);
    expect(result.config?.headerContent).toContain("user www-data");
    expect(result.config?.headerContent).toContain("worker_connections 768");
  });

  test("should extract stunnel comments", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    expect(result.success).toBe(true);
    expect(result.config?.stunnelComments).toContain("stunnel 19351");
    expect(result.config?.stunnelComments).toContain("Twitch Stockholm");
  });

  test("should detect configured stream proxy targets from nginx.conf", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG_WITH_STREAM_PROXY);

    expect(result.success).toBe(true);
    expect(result.config?.streamTargets).toEqual([{ id: "twitch_failover_proxy" }]);
  });

  test("should not keep managed stream block in footer content", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG_WITH_STREAM_PROXY);

    expect(result.success).toBe(true);
    expect(result.config?.footerContent).not.toContain("stream {");
    expect(result.config?.footerContent.trim()).toBe("");
  });
});

describe("getApplicationByName", () => {
  test("should find existing application", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    if (result.success && result.config) {
      const app = getApplicationByName(result.config, "twitch_stockholm");
      expect(app).toBeDefined();
      expect(app?.name).toBe("twitch_stockholm");
    }
  });

  test("should find vk application", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    if (result.success && result.config) {
      const app = getApplicationByName(result.config, "vk");
      expect(app).toBeDefined();
      expect(app?.name).toBe("vk");
      expect(app?.isProtected).toBe(true);
    }
  });

  test("should return undefined for non-existing application", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    if (result.success && result.config) {
      const app = getApplicationByName(result.config, "non_existing");
      expect(app).toBeUndefined();
    }
  });
});

describe("applicationNameExists", () => {
  test("should return true for existing application", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    if (result.success && result.config) {
      expect(applicationNameExists(result.config, "twitch_stockholm")).toBe(true);
      expect(applicationNameExists(result.config, "vk")).toBe(true);
    }
  });

  test("should return false for non-existing application", () => {
    const result = parseNginxConfig(SAMPLE_CONFIG);

    if (result.success && result.config) {
      expect(applicationNameExists(result.config, "non_existing")).toBe(false);
    }
  });
});
