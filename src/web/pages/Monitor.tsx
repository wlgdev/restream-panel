import React, { useEffect, useState, useRef } from "react";
import type {
  MonitorSnapshot,
  ConnectionItem,
  StreamEvent,
} from "../types";
import type { BandwidthPoint } from "../../core/types";
import { StreamBandwidthChart } from "../components/StreamBandwidthChart";
import {
  eventDescription,
  eventTypeClass,
  eventTypeLabel,
  formatBitrate,
  formatBytes,
  formatDuration,
  formatEventTime,
  formatRtt,
  formatTrack,
  healthTone,
  protoColor,
  targetColor,
  targetLabel,
} from "../lib/format";

// Log filter groups (chips) and severity (entry accent bar) derive from the
// same event type: groups answer "what object", severity answers "good/bad".
const eventGroup = (type: string): "streams" | "targets" | "quality" => {
  if (type === "stream_start" || type === "stream_end") return "streams";
  if (type === "quality_degraded") return "quality";
  return "targets";
};

const eventSev = (type: string): "up" | "down" | "degraded" | "info" => {
  switch (type) {
    case "stream_start":
    case "target_connected":
      return "up";
    case "stream_end":
    case "target_disconnected":
      return "down";
    case "quality_degraded":
      return "degraded";
    default:
      return "info";
  }
};

export function Monitor() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bandwidthHistory, setBandwidthHistory] = useState<Record<string, BandwidthPoint[]>>({});

  const [eventLog, setEventLog] = useState<StreamEvent[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "streams" | "targets" | "quality">("all");
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isStickyRef = useRef(true);

  // Connection health is tracked separately from server-reported errors:
  // a dropped SSE keeps the last frame on screen behind a stale banner,
  // while snapshot.errors[] surface as their own banner.
  const [sseHealth, setSseHealth] = useState<"live" | "stale">("live");
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());

  // Each SSE frame carries the full snapshot (streams, full event buffer, full
  // retained bandwidth history), so state is replaced, never merged.
  useEffect(() => {
    const source = new EventSource("/api/monitor/stream");

    source.onmessage = (event) => {
      let data: MonitorSnapshot;
      try {
        data = JSON.parse(event.data) as MonitorSnapshot;
      } catch {
        setConnError("Invalid monitor frame.");
        return;
      }

      setSnapshot(data);
      setBandwidthHistory(data.bandwidth ?? {});
      setEventLog(data.events ?? []);

      if (isStickyRef.current && logContainerRef.current) {
        setTimeout(() => {
          if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
          }
        }, 0);
      }

      setConnError(null);
      setSseHealth("live");
      setLastFrameAt(Date.now());
      setLoading(false);
    };

    source.onerror = () => {
      // EventSource retries on its own; flag it but keep the last frame visible.
      setConnError("Lost connection to monitor stream, retrying…");
      setSseHealth("stale");
      setLoading(false);
    };

    return () => {
      source.close();
    };
  }, []);

  // Re-render clock so the STALE age ticks without new frames.
  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const handleLogScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, clientHeight, scrollHeight } = logContainerRef.current;
    isStickyRef.current = scrollTop + clientHeight >= scrollHeight - 16;
  };

  const rttClass = (item: ConnectionItem) => {
    if (item.rtt <= 0) return "";
    if (item.rtt < 60) return "text-good";
    if (item.rtt <= 120) return "text-warn";
    return "text-bad";
  };

  const txClass = (item: ConnectionItem, inbound: ConnectionItem | null) => {
    if (item.target === "INBOUND") return "";
    const reference = inbound?.rx_bps ?? 0;
    if (reference === 0) return "text-good";
    const diff = (Math.abs(item.tx_bps - reference) / reference) * 100;
    if (diff <= 5) return "text-good";
    if (diff <= 12) return "text-warn";
    return "text-bad";
  };

  const rtmpRetransClass = (item: ConnectionItem) => {
    if (item.target === "INBOUND") return "";
    if (item.drop_percent < 0.5) return "text-good";
    if (item.drop_percent <= 2) return "text-warn";
    return "text-bad";
  };

  const srtLossClass = (item: ConnectionItem) => {
    if (item.drop_percent < 0.5) return "text-good";
    if (item.drop_percent <= 2) return "text-warn";
    return "text-bad";
  };

  const srtBufferClass = (item: ConnectionItem) => {
    const bufferMs = item.target === "INBOUND" ? (item.recv_buffer_ms ?? 0) : (item.send_buffer_ms ?? 0);
    if (bufferMs <= 0) return "";
    const delta = item.target === "INBOUND" ? Math.max(0, bufferMs - (item.tsbpd_delay_ms ?? 0)) : bufferMs;
    if (delta < 80) return "text-good";
    if (delta <= 200) return "text-warn";
    return "text-bad";
  };

  // The frame already carries server-merged logical streams, orphans and errors —
  // the page only derives view slices, never merges.
  const streams = snapshot?.streams ?? [];
  const orphans = snapshot?.orphans ?? [];
  const serverErrors = snapshot?.errors ?? [];

  const orphanRtmp = orphans.filter((item) => item.protocol === "RTMP" || item.protocol === "RTMPS");
  const orphanSrt = orphans.filter((item) => item.protocol === "SRT" || item.protocol === "SRTLA");

  const totalConnections =
    streams.reduce((count, stream) => count + (stream.inbound ? 1 : 0) + stream.outbound.length, 0) +
    orphans.length;

  const updatedAt = snapshot?.timestamp;

  const staleForSec =
    lastFrameAt !== null ? Math.max(0, Math.floor((nowTs - lastFrameAt) / 1000)) : null;
  const isStale = sseHealth === "stale" || (staleForSec !== null && staleForSec > 10);
  const showEmpty = !loading && lastFrameAt !== null && streams.length === 0 && orphans.length === 0;

  let streamCount = 0;
  let targetCount = 0;
  let qualityCount = 0;
  for (const entry of eventLog) {
    const group = eventGroup(entry.type);
    if (group === "streams") streamCount += 1;
    else if (group === "targets") targetCount += 1;
    else qualityCount += 1;
  }
  const filteredLog =
    logFilter === "all" ? eventLog : eventLog.filter((entry) => eventGroup(entry.type) === logFilter);

  const renderStreamTable = (items: ConnectionItem[], inbound: ConnectionItem | null) => (
    <div className="health-table-wrap">
      <table className="health-table">
        <colgroup>
          <col className="health-col-target" />
          <col className="health-col-proto" />
          <col className="health-col-health" />
          <col className="health-col-peer" />
          <col className="health-col-rate" />
          <col className="health-col-rate" />
          <col className="health-col-rtt" />
          <col className="health-col-bytes" />
          <col className="health-col-queue" />
          <col className="health-col-retrans" />
        </colgroup>
        <thead>
          <tr>
            <th>Target</th>
            <th>Proto</th>
            <th>Health</th>
            <th>Peer</th>
            <th>Tx</th>
            <th>Rx</th>
            <th>RTT</th>
            <th>Data/Buf</th>
            <th>Queue</th>
            <th>Retrans</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => {
            // SRTLA is an inbound-only variant of SRT; it shares SRT's connection metrics and
            // rendering path (RTT/jitter, buffer ms, loss/retrans columns), only the proto
            // badge differs. Treat both protocols as SRT for table rendering decisions.
            const isSrt = item.protocol === "SRT" || item.protocol === "SRTLA";
            const protocol = item.protocol ?? "RTMP";
            const bufferMs = item.target === "INBOUND" ? (item.recv_buffer_ms ?? 0) : (item.send_buffer_ms ?? 0);
            const queueValue = item.target === "INBOUND" ? item.recv_q : item.send_q;

            return (
              <tr key={idx}>
                <td className="health-mono cell-code" style={{ color: targetColor(item.target) }}>
                  {targetLabel(item.target)}
                </td>
                <td className="health-mono cell-code" style={{ color: protoColor(protocol) }}>
                  {protocol}
                </td>
                <td className="health-mono cell-code" style={{ color: healthTone(item.health) }}>
                  {item.health}%
                </td>
                <td className="health-mono">{item.peer_ip ?? "-"}</td>
                <td className={`health-mono ${txClass(item, inbound)}`}>{formatBitrate(item.tx_bps)}</td>
                <td className="health-mono">{formatBitrate(item.rx_bps)}</td>
                <td className={`health-mono ${rttClass(item)}`}>
                  {isSrt
                    ? `${item.rtt > 0 ? item.rtt.toFixed(1) : "-"}/${
                        item.rtt_jitter && item.rtt_jitter > 0 ? `${item.rtt_jitter.toFixed(1)}ms` : "-"
                      }`
                    : formatRtt(item.rtt)}
                </td>
                <td className={`health-mono ${isSrt ? srtBufferClass(item) : ""}`}>
                  {isSrt
                    ? bufferMs > 0
                      ? `${bufferMs.toFixed(0)} ms`
                      : "-"
                    : `${formatBytes(item.bytes_sent)}/${formatBytes(item.bytes_received)}`}
                </td>
                <td className="health-mono">{formatBytes(queueValue)}</td>
                <td className={`health-mono ${isSrt ? srtLossClass(item) : rtmpRetransClass(item)}`}>
                  {isSrt
                    ? `${item.drop_percent.toFixed(2)}%/${item.retrans_total}`
                    : item.target === "INBOUND"
                      ? "-"
                      : `${item.drop_percent.toFixed(2)}%/${item.retrans_total}`}
                </td>
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
                <h1>MediaMTX Monitor</h1>
                <div className="header-meta">Live snapshot of RTMP pushes and SRT relay sessions</div>
              </div>
            </div>
            <div className="header-actions">
              <div className="version-badge" title="Panel version">
                {typeof VERSION === "undefined" ? "dev" : VERSION}
              </div>
              <div className={`status-badge ${isStale ? "stale" : "running"}`}>
                <div className="status-dot"></div>
                <span>{isStale ? "stale" : "live"}</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container health-page">
        <section className="toolbar health-toolbar">
          <div className="stat-group">
            <span className="stat">
              Streams <b>{streams.length}</b>
            </span>
            <span className="stat">
              Connections <b>{totalConnections}</b>
            </span>
          </div>
          <span className="toolbar-info">
            {updatedAt
              ? `Updated ${new Date(updatedAt).toLocaleTimeString("en-US", { hour12: false })}`
              : "Waiting for first update"}
            {isStale && staleForSec !== null ? ` · STALE ${staleForSec}s ago` : ""}
          </span>
        </section>

        {connError && <div className="alert alert-warning">{connError}</div>}
        {serverErrors.length > 0 && (
          <div className="alert alert-error">{serverErrors.join(" | ")}</div>
        )}

        {loading && totalConnections === 0 && (
          <section className="card health-card">
            <div className="health-empty" style={{ textAlign: "center", padding: "2rem" }}>
              Loading stream connections...
            </div>
          </section>
        )}

        {showEmpty && (
          <section className="card health-card">
            <div className="health-empty" style={{ textAlign: "center", padding: "2rem" }}>
              No active streams — waiting for publisher.
            </div>
          </section>
        )}

        {streams.map((stream) => {
              const allItems: ConnectionItem[] = [];
              if (stream.inbound) allItems.push(stream.inbound);
              allItems.push(...stream.outbound);

              const tracks = stream.tracks?.length ? stream.tracks : null;
              const worstHealth =
                allItems.length > 0 ? Math.min(...allItems.map((c) => c.health)) : 100;
              const metaParts = [
                stream.inbound?.peer_ip ?? "Unknown source",
                `Uptime ${formatDuration(stream.startedAt)}`,
                ...(tracks ? [tracks.map(formatTrack).join(" · ")] : []),
                ...(stream.readers !== undefined
                  ? [`${stream.readers} reader${stream.readers !== 1 ? "s" : ""}`]
                  : []),
                ...(stream.outbound.length > 0
                  ? [`${stream.outbound.length} target${stream.outbound.length !== 1 ? "s" : ""}`]
                  : []),
              ];

              return (
                <section key={`combined-${stream.id}`} className="card stream-block">
                  <div className="stream-head stream-plaque">
                    <span
                      className="plaque-dot"
                      style={{ backgroundColor: healthTone(worstHealth) }}
                    />
                    <div className="plaque-main">
                      <h3 className="stream-title">{stream.id}</h3>
                      <div className="stream-meta">{metaParts.join(" · ")}</div>
                    </div>
                    <div className="plaque-stats">
                      <div className="plaque-bitrate">
                        {formatBitrate(stream.inbound?.rx_bps ?? 0)}
                      </div>
                    </div>
                  </div>
                  <StreamBandwidthChart
                    streamId={stream.id}
                    history={bandwidthHistory[stream.id] || []}
                    inbound={stream.inbound}
                    outbound={stream.outbound}
                  />
                  {allItems.length > 0 && renderStreamTable(allItems, stream.inbound)}
                </section>
              );
            })}

        {(orphanRtmp.length > 0 || orphanSrt.length > 0) && (
          <section className="card health-card">
            <div className="health-status-row">
              <div>
                <div className="card-title">Unassociated Connections</div>
                <div className="card-subtitle">Connections not matched to a logical stream</div>
              </div>
            </div>
            {orphanRtmp.length > 0 && (
              <>
                <div className="stream-subhead">RTMP</div>
                {renderStreamTable(orphanRtmp, null)}
              </>
            )}
            {orphanSrt.length > 0 && (
              <>
                <div className="stream-subhead">SRT</div>
                {renderStreamTable(orphanSrt, null)}
              </>
            )}
          </section>
        )}

        <section className="card event-log-card">
          <div className="health-status-row log-head">
            <div>
              <div className="card-title">Event stream</div>
              <div className="card-subtitle">
                {logFilter === "all"
                  ? `${eventLog.length} event${eventLog.length !== 1 ? "s" : ""} recorded`
                  : `${filteredLog.length} of ${eventLog.length} shown`}
              </div>
            </div>
            <div className={`status-badge ${isStickyRef.current ? "running" : ""}`}>
              <div className="status-dot"></div>
              <span>{isStickyRef.current ? "auto-scroll active" : "auto-scroll paused"}</span>
            </div>
          </div>
          <div className="chart-btn-group log-filters">
            <button
              type="button"
              className={`chart-btn ${logFilter === "all" ? "active" : ""}`}
              onClick={() => setLogFilter("all")}
            >
              All {eventLog.length}
            </button>
            <button
              type="button"
              className={`chart-btn ${logFilter === "streams" ? "active" : ""}`}
              onClick={() => setLogFilter("streams")}
            >
              Streams {streamCount}
            </button>
            <button
              type="button"
              className={`chart-btn ${logFilter === "targets" ? "active" : ""}`}
              onClick={() => setLogFilter("targets")}
            >
              Targets {targetCount}
            </button>
            <button
              type="button"
              className={`chart-btn ${logFilter === "quality" ? "active" : ""}`}
              onClick={() => setLogFilter("quality")}
            >
              Quality {qualityCount}
            </button>
          </div>
          <div className="event-log-container" ref={logContainerRef} onScroll={handleLogScroll}>
            {filteredLog.length === 0 ? (
              <div className="health-empty" style={{ padding: "2rem" }}>
                {eventLog.length === 0 ? "No events yet." : "Nothing in this group."}
              </div>
            ) : (
              filteredLog.map((event, idx) => (
                <div key={event.seq || idx} className={`event-log-entry sev-${eventSev(event.type)}`}>
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
