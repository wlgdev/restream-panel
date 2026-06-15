import React, { useEffect, useMemo, useState, useRef } from "react";
import type {
  CombinedHealthSnapshot,
  HealthSnapshot,
  LogicalStreamItem,
  StreamHealthItem,
  StreamEvent,
} from "../types";
import * as api from "../api";

export function Health() {
  const [snapshot, setSnapshot] = useState<CombinedHealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId] = useState(
    () => globalThis.crypto?.randomUUID?.() ?? "health-" + Math.random().toString(36).slice(2),
  );
  const [loading, setLoading] = useState(true);

  const [eventLog, setEventLog] = useState<StreamEvent[]>([]);
  const lastSeqRef = useRef<number | undefined>(undefined);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isStickyRef = useRef(true);

  useEffect(() => {
    let mounted = true;

    const fetchHealth = async () => {
      try {
        const data = await api.getStreams(clientId, lastSeqRef.current);
        if (!mounted) return;

        setSnapshot(data);

        if (data.events && data.events.length > 0) {
          setEventLog((prev) => {
            const newLog = [...prev, ...data.events];
            if (newLog.length > 10000) {
              return newLog.slice(newLog.length - 10000);
            }
            return newLog;
          });
          lastSeqRef.current = data.events[data.events.length - 1]?.seq;

          if (isStickyRef.current && logContainerRef.current) {
            setTimeout(() => {
              if (logContainerRef.current) {
                logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
              }
            }, 0);
          }
        }

        const errors = [data.rtmp.error, data.srt.error].filter(Boolean);
        setError(errors.length > 0 ? errors.join(" | ") : null);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Failed to load stream snapshot.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
      api.disconnectClient(clientId).catch(console.error);
    };
  }, [clientId]);

  const formatBytes = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size >= 100 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
  };

  const formatBitrate = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return "0 kbps";
    const units = ["kbps", "Mbps", "Gbps", "Tbps"];
    let rate = value / 1000;
    let index = 0;
    while (rate >= 1000 && index < units.length - 1) {
      rate /= 1000;
      index += 1;
    }
    return `${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)} ${units[index]}`;
  };

  const formatRtt = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return "-";
    return `${value.toFixed(1)} ms`;
  };

  const formatDuration = (startedAt: number) => {
    const now = Date.now();
    const diffMs = now - startedAt;
    if (diffMs < 0) return "0s";
    const totalSec = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  };

  const handleLogScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, clientHeight, scrollHeight } = logContainerRef.current;
    isStickyRef.current = scrollTop + clientHeight >= scrollHeight - 16;
  };

  const eventTypeLabel = (type: string) => {
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
  };

  const eventTypeClass = (type: string) => {
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
  };

  const formatEventTime = (iso: string) => {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    const time = d.toLocaleTimeString("en-US", { hour12: false });
    return `${dd}.${mm}.${yy} ${time}`;
  };

  const eventDescription = (event: StreamEvent) => {
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
  };

  const targetLabel = (target: string) => {
    if (target === "INBOUND") return "Inbound";
    if (target === "TWITCH") return "Twitch";
    if (target === "VK") return "VK";
    if (target === "YOUTUBE") return "YouTube";
    if (target === "UNKNOWN") return "Unknown";
    if (target === "OUTBOUND") return "Outbound";
    return target;
  };

  const healthClass = (value: number) => {
    if (value >= 90) return "health-good";
    if (value >= 70) return "health-warn";
    return "health-bad";
  };

  const rttClass = (item: StreamHealthItem) => {
    if (item.rtt <= 0) return "";
    if (item.rtt < 60) return "text-good";
    if (item.rtt <= 120) return "text-warn";
    return "text-bad";
  };

  const txClass = (item: StreamHealthItem, inbound: StreamHealthItem | null) => {
    if (item.target === "INBOUND") return "";
    const reference = inbound?.rx_bps ?? 0;
    if (reference === 0) return "text-good";
    const diff = (Math.abs(item.tx_bps - reference) / reference) * 100;
    if (diff <= 5) return "text-good";
    if (diff <= 12) return "text-warn";
    return "text-bad";
  };

  const rtmpRetransClass = (item: StreamHealthItem) => {
    if (item.target === "INBOUND") return "";
    if (item.drop_percent < 0.5) return "text-good";
    if (item.drop_percent <= 2) return "text-warn";
    return "text-bad";
  };

  const srtLossClass = (item: StreamHealthItem) => {
    if (item.drop_percent < 0.5) return "text-good";
    if (item.drop_percent <= 2) return "text-warn";
    return "text-bad";
  };

  const srtBufferClass = (item: StreamHealthItem) => {
    const bufferMs = item.target === "INBOUND" ? (item.recv_buffer_ms ?? 0) : (item.send_buffer_ms ?? 0);
    if (bufferMs <= 0) return "";
    const delta = item.target === "INBOUND" ? Math.max(0, bufferMs - (item.tsbpd_delay_ms ?? 0)) : bufferMs;
    if (delta < 80) return "text-good";
    if (delta <= 200) return "text-warn";
    return "text-bad";
  };

  const snapshots = useMemo(
    () => ({
      rtmp: snapshot?.rtmp ?? null,
      srt: snapshot?.srt ?? null,
    }),
    [snapshot],
  );

  const combinedStreams = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        startedAt: number;
        inbound: StreamHealthItem | null;
        outbound: StreamHealthItem[];
      }
    >();

    if (snapshots.srt) {
      for (const s of snapshots.srt.streams) {
        map.set(s.id, {
          id: s.id,
          startedAt: s.startedAt,
          inbound: s.inbound,
          outbound: [...s.outbound],
        });
      }
    }

    if (snapshots.rtmp) {
      for (const s of snapshots.rtmp.streams) {
        if (map.has(s.id)) {
          const existing = map.get(s.id)!;
          existing.outbound.push(...s.outbound);
          if (!existing.inbound && s.inbound) {
            existing.inbound = s.inbound;
          }
          existing.startedAt = Math.min(existing.startedAt, s.startedAt);
        } else {
          map.set(s.id, {
            id: s.id,
            startedAt: s.startedAt,
            inbound: s.inbound,
            outbound: [...s.outbound],
          });
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [snapshots]);

  const totalConnections = (snapshots.rtmp?.data.length ?? 0) + (snapshots.srt?.data.length ?? 0);
  const totalStreams = (snapshots.rtmp?.streams.length ?? 0) + (snapshots.srt?.streams.length ?? 0);

  const updatedAt = [snapshots.rtmp?.timestamp, snapshots.srt?.timestamp]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  const renderRtmpTable = (items: StreamHealthItem[], inbound: StreamHealthItem | null) => (
    <div className="health-table-wrap">
      <table className="health-table">
        <colgroup>
          <col className="health-col-target" />
          <col className="health-col-health" />
          <col className="health-col-peer" />
          <col className="health-col-rate" />
          <col className="health-col-rate" />
          <col className="health-col-bytes" />
          <col className="health-col-bytes" />
          <col className="health-col-rtt" />
          <col className="health-col-queue" />
          <col className="health-col-retrans" />
        </colgroup>
        <thead>
          <tr>
            <th>Target</th>
            <th>Health</th>
            <th>Peer</th>
            <th>Tx</th>
            <th>Rx</th>
            <th>Sent</th>
            <th>Received</th>
            <th>RTT</th>
            <th>Queue</th>
            <th>Retrans</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => (
            <tr key={idx}>
              <td className="health-badge-cell">
                <span className={`target-pill target-${item.target.toLowerCase()}`}>{targetLabel(item.target)}</span>
              </td>
              <td className="health-badge-cell">
                <span className={`health-pill ${healthClass(item.health)}`}>{item.health}%</span>
              </td>
              <td className="health-mono">{item.peer_ip ?? "-"}</td>
              <td className={`health-mono ${txClass(item, inbound)}`}>{formatBitrate(item.tx_bps)}</td>
              <td className="health-mono">{formatBitrate(item.rx_bps)}</td>
              <td className="health-mono">{formatBytes(item.bytes_sent)}</td>
              <td className="health-mono">{formatBytes(item.bytes_received)}</td>
              <td className={`health-mono ${rttClass(item)}`}>{formatRtt(item.rtt)}</td>
              <td className="health-mono">
                {item.target === "INBOUND" ? formatBytes(item.recv_q) : formatBytes(item.send_q)}
              </td>
              <td className={`health-mono ${rtmpRetransClass(item)}`}>
                {item.target === "INBOUND" ? "-" : `${item.drop_percent.toFixed(2)}% / ${item.retrans_total}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const renderSrtTable = (items: StreamHealthItem[], inbound: StreamHealthItem | null) => (
    <div className="health-table-wrap">
      <table className="health-table">
        <colgroup>
          <col className="health-col-target" />
          <col className="health-col-health" />
          <col className="health-col-peer" />
          <col className="health-col-rate" />
          <col className="health-col-rate" />
          <col className="health-col-bytes" />
          <col className="health-col-bytes" />
          <col className="health-col-rtt" />
          <col className="health-col-queue" />
          <col className="health-col-retrans" />
        </colgroup>
        <thead>
          <tr>
            <th>Target</th>
            <th>Health</th>
            <th>Peer</th>
            <th>Tx</th>
            <th>Rx</th>
            <th>RTT</th>
            <th>Buffer</th>
            <th>Queue</th>
            <th>Loss</th>
            <th>Retrans</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => {
            const bufferMs = item.target === "INBOUND" ? (item.recv_buffer_ms ?? 0) : (item.send_buffer_ms ?? 0);
            const queueValue = item.target === "INBOUND" ? item.recv_q : item.send_q;

            return (
              <tr key={idx}>
                <td className="health-badge-cell">
                  <span className={`target-pill target-${item.target.toLowerCase()}`}>{targetLabel(item.target)}</span>
                </td>
                <td className="health-badge-cell">
                  <span className={`health-pill ${healthClass(item.health)}`}>{item.health}%</span>
                </td>
                <td className="health-mono">{item.peer_ip ?? "-"}</td>
                <td className={`health-mono ${txClass(item, inbound)}`}>{formatBitrate(item.tx_bps)}</td>
                <td className="health-mono">{formatBitrate(item.rx_bps)}</td>
                <td className={`health-mono ${rttClass(item)}`}>
                  {item.rtt > 0 ? `${item.rtt.toFixed(1)}` : "-"}/
                  {item.rtt_jitter && item.rtt_jitter > 0 ? `${item.rtt_jitter.toFixed(1)}ms` : "-"}
                </td>
                <td className={`health-mono ${srtBufferClass(item)}`}>
                  {bufferMs > 0 ? `${bufferMs.toFixed(0)} ms` : "-"}
                </td>
                <td className="health-mono">{formatBytes(queueValue)}</td>
                <td className={`health-mono ${srtLossClass(item)}`}>{item.drop_percent.toFixed(2)}%</td>
                <td className="health-mono">{item.retrans_total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <header className="header">
        <div className="container">
          <div className="header-content">
            <div className="header-brand">
              <svg
                className="header-logo"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
                <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4"></path>
                <circle cx="12" cy="12" r="2"></circle>
                <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4"></path>
                <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>
              </svg>
              <div>
                <h1>Stream Health</h1>
                <div className="header-meta">Live snapshot of RTMP pushes and SRT relay sessions</div>
              </div>
            </div>
            <div className="header-actions">
              <div className="version-badge" title="Panel version">
                {typeof VERSION === "undefined" ? "dev" : VERSION}
              </div>
              <div className="status-badge running">
                <div className="status-dot"></div>
                <span>refresh every 5s</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container health-page">
        <section className="toolbar health-toolbar">
          <span className="toolbar-info">
            {loading
              ? "Loading connection snapshot..."
              : error
                ? "Monitoring error"
                : `${totalConnections} connections • ${combinedStreams.length} stream${combinedStreams.length !== 1 ? "s" : ""}`}
          </span>
          <span className="toolbar-info">
            {updatedAt ? `Updated ${new Date(updatedAt).toLocaleString()}` : "Waiting for first update"}
          </span>
        </section>

        {error && <div className="alert alert-error">{error}</div>}

        {loading && totalConnections === 0 && (
          <section className="card health-card">
            <div className="health-empty" style={{ textAlign: "center", padding: "2rem" }}>
              Loading stream connections...
            </div>
          </section>
        )}

        {combinedStreams.length > 0 && (
          <section className="card health-card">
            <div className="health-status-row">
              <div>
                <div className="card-title">Active Streams</div>
                <div className="card-subtitle">
                  {combinedStreams.length} logical stream{combinedStreams.length !== 1 ? "s" : ""}
                </div>
              </div>
              <div className="status-badge running">
                <div className="status-dot"></div>
                <span>monitor active</span>
              </div>
            </div>

            {combinedStreams.map((stream) => {
              const allItems: StreamHealthItem[] = [];
              if (stream.inbound) allItems.push(stream.inbound);
              allItems.push(...stream.outbound);

              const minHealth = Math.min(...allItems.map((item) => item.health));

              const srtItems = allItems.filter((i) => "protocol" in i && (i as any).protocol === "SRT");
              const rtmpItems = allItems.filter((i) => !("protocol" in i) || (i as any).protocol !== "SRT");

              return (
                <div key={`combined-${stream.id}`} className="stream-card">
                  <div
                    className="card-subtitle"
                    style={{ textAlign: "center", marginBottom: "1rem", marginTop: "-0.5rem" }}
                  >
                    <span className={`health-pill ${healthClass(minHealth)}`} style={{ marginRight: "0.5rem" }}>
                      {minHealth}%
                    </span>
                    Stream {stream.id} • {stream.inbound?.peer_ip ?? "Unknown source"} • Uptime{" "}
                    {formatDuration(stream.startedAt)}
                    {stream.outbound.length > 0 &&
                      ` • ${stream.outbound.length} consumer${stream.outbound.length !== 1 ? "s" : ""}`}
                  </div>
                  {srtItems.length > 0 && renderSrtTable(srtItems, stream.inbound)}
                  {rtmpItems.length > 0 && renderRtmpTable(rtmpItems, stream.inbound)}
                </div>
              );
            })}
          </section>
        )}

        {(() => {
          const orphanRtmp = snapshots.rtmp?.data.filter((item) => !item.stream_id) ?? [];
          if (orphanRtmp.length === 0) return null;
          return (
            <section className="card health-card">
              <div className="health-status-row">
                <div>
                  <div className="card-title">Unassociated RTMP Connections</div>
                  <div className="card-subtitle">Connections not matched to a logical stream</div>
                </div>
              </div>
              {renderRtmpTable(orphanRtmp, null)}
            </section>
          );
        })()}

        {(() => {
          const orphanSrt = snapshots.srt?.data.filter((item) => !item.stream_id) ?? [];
          if (orphanSrt.length === 0) return null;
          return (
            <section className="card health-card">
              <div className="health-status-row">
                <div>
                  <div className="card-title">Unassociated SRT Connections</div>
                  <div className="card-subtitle">Connections not matched to a logical stream</div>
                </div>
              </div>
              {renderSrtTable(orphanSrt, null)}
            </section>
          );
        })()}

        <section className="card event-log-card">
          <div className="health-status-row">
            <div>
              <div className="card-title">Event Log</div>
              <div className="card-subtitle">
                {eventLog.length} event{eventLog.length !== 1 ? "s" : ""} recorded
              </div>
            </div>
            <div className={`status-badge ${isStickyRef.current ? "running" : ""}`}>
              <div className="status-dot"></div>
              <span>{isStickyRef.current ? "auto-scroll active" : "auto-scroll paused"}</span>
            </div>
          </div>
          <div className="event-log-container" ref={logContainerRef} onScroll={handleLogScroll}>
            {eventLog.length === 0 ? (
              <div className="health-empty" style={{ padding: "2rem" }}>
                No events yet.
              </div>
            ) : (
              eventLog.map((event, idx) => (
                <div key={event.seq || idx} className="event-log-entry">
                  <div className="event-log-timestamp">{formatEventTime(event.timestamp)}</div>
                  <div className={`event-log-type ${eventTypeClass(event.type)}`}>
                    {event.type === "stream_start" || event.type === "target_connected" ? "● " : ""}
                    {event.type === "stream_end" || event.type === "target_disconnected" ? "✕ " : ""}
                    {event.type === "quality_degraded" ? "▲ " : ""}
                    {eventTypeLabel(event.type)}
                  </div>
                  <div className="event-log-stream">{event.streamId}</div>
                  <div className="event-log-detail">{eventDescription(event)}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </>
  );
}
