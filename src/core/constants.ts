import type { TargetServer } from "./types";

export const PROTECTED_APPLICATIONS = [
  "twitch_stockholm",
  "twitch_frankfurt",
  "twitch_paris",
  "twitch_failover",
  "vk",
  "youtube",
] as const;

export type ProtectedApplicationName = (typeof PROTECTED_APPLICATIONS)[number];

export const TARGET_SERVERS: TargetServer[] = [
  {
    id: "twitch_stockholm",
    name: "Twitch Stockholm",
    url: "rtmp://127.0.0.1:19351/app",
    requiresStreamKey: true,
  },
  {
    id: "twitch_frankfurt",
    name: "Twitch Frankfurt",
    url: "rtmp://127.0.0.1:19352/app",
    requiresStreamKey: true,
  },
  {
    id: "twitch_paris",
    name: "Twitch Paris",
    url: "rtmp://127.0.0.1:19353/app",
    requiresStreamKey: true,
  },
  {
    id: "twitch_failover",
    name: "Twitch Failover",
    url: "rtmp://127.0.0.1:19360/app",
    requiresStreamKey: true,
  },
  {
    id: "vk",
    name: "VK",
    url: "rtmp://vsu.mycdn.me/input",
    requiresStreamKey: true,
  },
  {
    id: "youtube",
    name: "YouTube",
    url: "rtmp://a.rtmp.youtube.com/live2",
    requiresStreamKey: true,
    supportsDynamicStreamKey: true,
  },
];

export function getTargetServerById(id: string): TargetServer | undefined {
  return TARGET_SERVERS.find((server) => server.id === id);
}

export function isProtectedApplication(name: string): boolean {
  return PROTECTED_APPLICATIONS.includes(name as ProtectedApplicationName);
}

export function isValidApplicationName(name: string): boolean {
  if (name.length === 0 || name.length > 64) {
    return false;
  }
  return /^[a-zA-Z0-9_]+$/.test(name);
}

export const NGINX_CONFIG_HEADER = `user www-data;
worker_processes 1;

pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}
`;

export const NGINX_CONFIG_FOOTER = "";

export const RTMP_SERVER_CONFIG = {
  listen: 1935,
  chunkSize: 4096,
};

export const RTMP_MONITOR_INBOUND_PORTS = [1935, 1936] as const;

export const NGINX_STREAM_FAILOVER_CONFIG = {
  listen: 1936,
  proxyPass: "127.0.0.1:19360",
  proxyConnectTimeout: "5s",
  proxyTimeout: "15s",
} as const;

export const PROTECTED_STREAM_TARGETS = [
  {
    id: "twitch_failover_proxy",
    name: "Twitch Failover Proxy",
    listenPort: NGINX_STREAM_FAILOVER_CONFIG.listen,
    proxyPass: NGINX_STREAM_FAILOVER_CONFIG.proxyPass,
    obsPath: "app",
    transportLabel: "↔ TCP Proxy",
    protectedLabel: "Protected Target",
    targetServerName: "Twitch Failover",
  },
] as const;
