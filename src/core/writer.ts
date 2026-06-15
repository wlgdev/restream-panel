import type { Application, NginxConfig, WriteResult } from "./types";
import {
  NGINX_CONFIG_FOOTER,
  NGINX_CONFIG_HEADER,
  NGINX_STREAM_FAILOVER_CONFIG,
  RTMP_SERVER_CONFIG,
} from "./constants";

export function generateNginxConfig(config: NginxConfig): WriteResult {
  try {
    const header = config.headerContent || NGINX_CONFIG_HEADER;
    const footer = config.footerContent || NGINX_CONFIG_FOOTER;
    const stunnelComments = "";

    const rtmpBlock = generateRtmpBlock(config.applications, stunnelComments);
    const streamSection = config.streamTargets
      .map((streamTarget) => generateStreamBlock(streamTarget.id))
      .filter((block): block is string => Boolean(block))
      .join("\n\n");

    const content = `${header}rtmp {
${rtmpBlock}
}${streamSection ? `\n\n${streamSection}` : ""}${footer}`;

    return {
      success: true,
      content,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to generate nginx.conf: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

function generateRtmpBlock(applications: Application[], stunnelComments: string): string {
  const lines: string[] = [];

  lines.push("    server {");
  lines.push(`        listen ${RTMP_SERVER_CONFIG.listen};`);
  lines.push(`        chunk_size ${RTMP_SERVER_CONFIG.chunkSize};`);
  lines.push("");

  if (stunnelComments) {
    lines.push(stunnelComments);
    lines.push("");
  }

  for (const app of applications) {
    const appBlock = generateApplicationBlock(app);
    lines.push(appBlock);
    lines.push("");
  }

  lines.push("    }");

  return lines.join("\n");
}

function generateStreamBlock(streamTargetId: string): string | null {
  if (streamTargetId !== "twitch_failover_proxy") {
    return null;
  }

  const lines: string[] = [];

  lines.push("stream {");
  lines.push("    server {");
  lines.push(`        listen ${NGINX_STREAM_FAILOVER_CONFIG.listen};`);
  lines.push("");
  lines.push(`        proxy_pass ${NGINX_STREAM_FAILOVER_CONFIG.proxyPass};`);
  lines.push("");
  lines.push(`        proxy_connect_timeout ${NGINX_STREAM_FAILOVER_CONFIG.proxyConnectTimeout};`);
  lines.push(`        proxy_timeout ${NGINX_STREAM_FAILOVER_CONFIG.proxyTimeout};`);
  lines.push("    }");
  lines.push("}");

  return lines.join("\n");
}

function generateApplicationBlock(app: Application): string {
  const lines: string[] = [];

  if (app.isProtected) {
    const displayName = formatApplicationName(app.name);
    lines.push(`        # ${displayName}`);
  }

  lines.push(`        application ${app.name} {`);
  lines.push("            live on;");
  lines.push("            record off;");
  lines.push("            drop_idle_publisher 15s;");
  lines.push("");

  for (const target of app.pushTargets) {
    const pushUrl = generatePushUrl(target.server.url, target.streamKey);
    lines.push(`            push ${pushUrl};`);
  }

  lines.push("        }");

  return lines.join("\n");
}

function generatePushUrl(baseUrl: string, streamKey: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (streamKey) {
    return `${normalizedBase}/${streamKey}`;
  }
  return normalizedBase;
}

function formatApplicationName(name: string): string {
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function generateDefaultConfig(): string {
  const defaultConfig: NginxConfig = {
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
        name: "twitch_frankfurt",
        isProtected: true,
        pushTargets: [
          {
            server: {
              id: "twitch_frankfurt",
              name: "Twitch Frankfurt",
              url: "rtmp://127.0.0.1:19352/app",
              requiresStreamKey: true,
            },
            streamKey: "",
          },
        ],
      },
      {
        name: "twitch_paris",
        isProtected: true,
        pushTargets: [
          {
            server: {
              id: "twitch_paris",
              name: "Twitch Paris",
              url: "rtmp://127.0.0.1:19353/app",
              requiresStreamKey: true,
            },
            streamKey: "",
          },
        ],
      },
      {
        name: "twitch_failover",
        isProtected: true,
        pushTargets: [
          {
            server: {
              id: "twitch_failover",
              name: "Twitch Failover",
              url: "rtmp://127.0.0.1:19360/app",
              requiresStreamKey: true,
            },
            streamKey: "",
          },
        ],
      },
      {
        name: "vk",
        isProtected: true,
        pushTargets: [
          {
            server: {
              id: "vk",
              name: "VK",
              url: "rtmp://vsu.mycdn.me/input",
              requiresStreamKey: true,
            },
            streamKey: "",
          },
        ],
      },
      {
        name: "youtube",
        isProtected: true,
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
      },
    ],
    streamTargets: [{ id: "twitch_failover_proxy" }],
    headerContent: NGINX_CONFIG_HEADER,
    footerContent: NGINX_CONFIG_FOOTER,
    stunnelComments: "",
  };

  const result = generateNginxConfig(defaultConfig);
  return result.content || "";
}
