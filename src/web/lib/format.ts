import type { ConnectionItem, StreamEvent, Track } from "../types";

// Single source of truth for stream encoding colors: the same hex drives both
// the uPlot series stroke and the table identity text, so a target reads
// identically in the table and on the chart.
export const TARGET_COLORS: Record<string, string> = {
  INBOUND: "#38bdf8",
  TWITCH: "#c084fc",
  VK: "#60a5fa",
  YOUTUBE: "#f87171",
  OUTBOUND: "#00ff88",
  UNKNOWN: "#fbbf24",
};

export const PROTO_COLORS: Record<string, string> = {
  SRT: "#5eead4",
  SRTLA: "#fbbf24",
  RTMP: "#a5b4fc",
  RTMPS: "#f9a8d4",
};

// Total lookups (never undefined — unknown keys fall back to neutral tones).
export function targetColor(target: string): string {
  return TARGET_COLORS[target.toUpperCase()] ?? "#fbbf24";
}

export function protoColor(protocol: string): string {
  return PROTO_COLORS[protocol.toUpperCase()] ?? "#a1a1aa";
}

// Readable-on-dark text tones for health states.
export function healthTone(value: number): string {
  if (value >= 90) return "#00ff88";
  if (value >= 70) return "#fbbf24";
  return "#f87171";
}

export function targetLabel(target: string): string {
  switch (target.toUpperCase()) {
    case "INBOUND":
      return "Inbound";
    case "TWITCH":
      return "Twitch";
    case "VK":
      return "VK";
    case "YOUTUBE":
      return "YouTube";
    case "OUTBOUND":
      return "Outbound";
    case "UNKNOWN":
      return "Unknown";
    default:
      return target;
  }
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export function formatBitrate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "0 kbps";
  const units = ["kbps", "Mbps", "Gbps", "Tbps"];
  let rate = value / 1000;
  let index = 0;
  while (rate >= 1000 && index < units.length - 1) {
    rate /= 1000;
    index += 1;
  }
  return `${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)} ${units[index]}`;
}

export function formatRtt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return `${value.toFixed(1)} ms`;
}

export function formatDuration(startedAt: number): string {
  const diffMs = Date.now() - startedAt;
  if (diffMs < 0) return "0s";
  const totalSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Render a single mediamtx track as a short token. Video tracks carry resolution +
// profile/level; audio tracks carry sample rate + channels. A track is treated as audio
// when its codecProps expose sampleRate/channelCount (mediamtx never sets width/height on
// audio, nor sampleRate/channelCount on video), so the two kinds render distinctly even
// when the codec string alone is ambiguous.
export function formatTrack(track: Track): string {
  const props = track.codecProps ?? {};
  const isAudio = props.sampleRate !== undefined || props.channelCount !== undefined;

  if (isAudio) {
    const rate = props.sampleRate
      ? `${props.sampleRate % 1000 === 0 ? props.sampleRate / 1000 : (props.sampleRate / 1000).toFixed(1)} kHz`
      : null;
    const channels = props.channelCount ? `${props.channelCount}ch` : null;
    return [track.codec, rate, channels].filter(Boolean).join(" ");
  }

  const resolution = props.width && props.height ? `${props.width}×${props.height}` : null;
  const profile = props.profile ? `${props.profile}${props.level ? `@${props.level}` : ""}` : null;
  return [track.codec, resolution, profile].filter(Boolean).join(" ");
}

export function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  const time = d.toLocaleTimeString("en-US", { hour12: false });
  return `${dd}.${mm}.${yy} ${time}`;
}

export function eventTypeLabel(type: string): string {
  switch (type) {
    case "stream_start":
      return "STREAM START";
    case "stream_end":
      return "STREAM END";
    case "target_connected":
      return "TARGET CONNECTED";
    case "target_disconnected":
      return "TARGET DISCONNECTED";
    case "quality_degraded":
      return "QUALITY DEGRADED";
    default:
      return type.toUpperCase();
  }
}

export function eventTypeClass(type: string): string {
  switch (type) {
    case "stream_start":
    case "target_connected":
      return "event-type-connected";
    case "stream_end":
    case "target_disconnected":
      return "event-type-disconnected";
    case "quality_degraded":
      return "event-type-degraded";
    default:
      return "";
  }
}

export function eventDescription(event: StreamEvent): string {
  if (event.type === "quality_degraded" && event.metrics) {
    return `${targetLabel(event.target)}  H:${event.metrics.health}%  Tx:${formatBitrate(event.metrics.tx_bps)}  RTT:${event.metrics.rtt}ms  Drop:${event.metrics.drop_percent}%`;
  }
  if (event.type === "target_connected" || event.type === "target_disconnected") {
    return `${targetLabel(event.target)} → ${event.peerIp ?? "unknown"}`;
  }
  if (event.type === "stream_start" || event.type === "stream_end") {
    return `Inbound from ${event.peerIp ?? "unknown"}`;
  }
  return targetLabel(event.target);
}

export type { ConnectionItem };
