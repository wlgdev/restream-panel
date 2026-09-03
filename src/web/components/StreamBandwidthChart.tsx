import React, { useEffect, useRef, useState, useMemo } from "react";
import uPlot from "uplot";
import type { ConnectionItem } from "../types";
import type { BandwidthPoint } from "../../core/types";
import { formatBitrate, targetColor, targetLabel } from "../lib/format";

export type { BandwidthPoint };

export interface StreamBandwidthSeriesMeta {
  key: string;
  label: string;
  target: string;
  color: string;
}

interface Props {
  streamId: string;
  history: BandwidthPoint[];
  inbound: ConnectionItem | null;
  outbound: ConnectionItem[];
}

function formatTime(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function StreamBandwidthChart({ streamId, history, inbound, outbound }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const uplotInstance = useRef<uPlot | null>(null);
  const appliedKeysRef = useRef<string[]>([]);

  const [windowSec, setWindowSec] = useState<number | "all">(600);
  const [isLive, setIsLive] = useState(true);
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;

  const seriesMetaList = useMemo(() => {
    const list: StreamBandwidthSeriesMeta[] = [];
    const keysSeen = new Set<string>();

    const hasInbound = inbound || history.some((h) => h.inboundBps !== null);
    if (hasInbound) {
      const peerLabel = inbound?.peer_ip ? ` (${inbound.peer_ip})` : "";
      list.push({
        key: "inbound",
        label: `Inbound${peerLabel}`,
        target: "INBOUND",
        color: targetColor("INBOUND"),
      });
      keysSeen.add("inbound");
    }

    for (const item of outbound) {
      const key = `${item.target}_${item.peer_ip || item.protocol || "dest"}`;
      if (!keysSeen.has(key)) {
        keysSeen.add(key);
        const peer = item.peer_ip || (item.protocol && item.protocol !== "RTMP" ? item.protocol : "");
        const peerLabel = peer ? ` (${peer})` : "";
        list.push({
          key,
          label: `${targetLabel(item.target)}${peerLabel}`,
          target: item.target,
          color: targetColor(item.target),
        });
      }
    }

    for (const point of history) {
      for (const key of Object.keys(point.outbounds)) {
        if (!keysSeen.has(key)) {
          keysSeen.add(key);
          const underscoreIdx = key.indexOf("_");
          const target = underscoreIdx !== -1 ? key.slice(0, underscoreIdx) : key;
          const peer = underscoreIdx !== -1 ? key.slice(underscoreIdx + 1) : "";
          const peerLabel = peer && peer !== "dest" && peer !== "RTMP" ? ` (${peer})` : "";
          list.push({
            key,
            label: `${targetLabel(target)}${peerLabel}`,
            target,
            color: targetColor(target),
          });
        }
      }
    }

    return list;
  }, [inbound, outbound, history]);


  const seriesMetaRef = useRef(seriesMetaList);
  seriesMetaRef.current = seriesMetaList;

  const chartData = useMemo(() => {
    if (history.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      const times = [now];
      const seriesArrays = seriesMetaList.map(() => [0]);
      return [times, ...seriesArrays] as uPlot.AlignedData;
    }

    const times = history.map((h) => h.time);
    const seriesArrays: (number | null)[][] = seriesMetaList.map((meta) => {
      if (meta.key === "inbound") {
        return history.map((h) => h.inboundBps);
      }
      return history.map((h) => h.outbounds[meta.key] ?? null);
    });

    return [times, ...seriesArrays] as uPlot.AlignedData;
  }, [history, seriesMetaList]);

  const chartDataRef = useRef(chartData);
  chartDataRef.current = chartData;

  // Latest value per series for the visible legend row.
  const legendItems = useMemo(
    () =>
      seriesMetaList.map((meta, i) => {
        const arr = chartData[i + 1] ?? [];
        let current: number | null = null;
        for (let k = arr.length - 1; k >= 0; k--) {
          const v = arr[k];
          if (v !== null && v !== undefined) {
            current = v;
            break;
          }
        }
        return { meta, current };
      }),
    [seriesMetaList, chartData],
  );

  useEffect(() => {
    if (!plotRef.current || !containerRef.current) return;

    if (uplotInstance.current) {
      uplotInstance.current.destroy();
      uplotInstance.current = null;
    }

    const width = containerRef.current.clientWidth || 800;
    const height = 220;

    const seriesConfig: uPlot.Series[] = [
      {
        label: "Time",
      },
      ...seriesMetaList.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 2,
        fill: `${s.color}15`,
        points: { show: false },
        spanGaps: true,
      })),
    ];

    const opts: uPlot.Options = {
      width,
      height,
      cursor: {
        sync: { key: `stream-${streamId}` },
        drag: {
          setScale: true,
          x: true,
          y: false,
        },
        points: {
          size: 5,
          width: 1,
          stroke: (u, seriesIdx) => (u.series[seriesIdx]?.stroke as string) || "#fff",
          fill: "#18181b",
        },
      },
      scales: {
        x: {
          time: true,
        },
        y: {
          auto: true,
          range: (u, min, max) => [0, Math.max(max * 1.15, 1_000_000)],
        },
      },
      axes: [
        {
          stroke: "#a1a1aa",
          grid: {
            stroke: "rgba(255, 255, 255, 0.05)",
            width: 1,
          },
          ticks: {
            stroke: "rgba(255, 255, 255, 0.1)",
            width: 1,
          },
          font: "10px JetBrains Mono, monospace",
        },
        {
          stroke: "#a1a1aa",
          grid: {
            stroke: "rgba(255, 255, 255, 0.05)",
            width: 1,
          },
          ticks: {
            stroke: "rgba(255, 255, 255, 0.1)",
            width: 1,
          },
          font: "10px JetBrains Mono, monospace",
          values: (u, splits) => splits.map((v) => formatBitrate(v)),
          size: 65,
        },
      ],
      legend: {
        show: false,
      },
      hooks: {
        setCursor: [
          (u) => {
            const tooltip = tooltipRef.current;
            if (!tooltip) return;

            const idx = u.cursor.idx;
            if (idx === null || idx === undefined || idx < 0) {
              tooltip.style.display = "none";
              return;
            }

            const currentData = chartDataRef.current;
            const currentSeries = seriesMetaRef.current;
            const timestamp = currentData[0]?.[idx];
            if (timestamp === undefined) {
              tooltip.style.display = "none";
              return;
            }

            let itemsHtml = "";
            for (let i = 0; i < currentSeries.length; i++) {
              const s = currentSeries[i]!;
              const val = currentData[i + 1]?.[idx];
              if (val === null || val === undefined) continue;
              itemsHtml += `
                <div class="chart-tooltip-row">
                  <span class="chart-tooltip-dot" style="background-color: ${s.color};"></span>
                  <span class="chart-tooltip-name">${s.label}:</span>
                  <span class="chart-tooltip-val">${formatBitrate(val)}</span>
                </div>
              `;
            }

            if (!itemsHtml) {
              tooltip.style.display = "none";
              return;
            }

            tooltip.innerHTML = `
              <div class="chart-tooltip-time">${formatTime(timestamp)}</div>
              ${itemsHtml}
            `;
            tooltip.style.display = "block";


            const tooltipWidth = tooltip.offsetWidth || 160;
            const plotWidth = u.width;
            let left = u.cursor.left ?? 0;
            if (left + tooltipWidth + 20 > plotWidth) {
              left = left - tooltipWidth - 15;
            } else {
              left = left + 15;
            }

            const top = Math.max(10, Math.min((u.cursor.top ?? 0) - 20, height - 90));
            tooltip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
          },
        ],
        setScale: [
          (u, key) => {
            if (key === "x" && isLiveRef.current) {
              const times = chartDataRef.current[0];
              if (times && times.length > 0) {
                const latest = times[times.length - 1]!;
                const scale = u.scales.x;
                if (scale && scale.max !== undefined && scale.max < latest - 10) {
                  setIsLive(false);
                }
              }
            }
          },
        ],
      },
      series: seriesConfig,
    };

    const inst = new uPlot(opts, chartData, plotRef.current);
    uplotInstance.current = inst;
    appliedKeysRef.current = seriesMetaList.map((s) => s.key);

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && uplotInstance.current) {
          uplotInstance.current.setSize({
            width: Math.floor(entry.contentRect.width),
            height,
          });
        }
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (uplotInstance.current) {
        uplotInstance.current.destroy();
        uplotInstance.current = null;
      }
    };
  }, [streamId]);

  // Series join/leave without destroying the instance (keeps zoom + live-follow).
  // ponytail: append-only — seriesMetaList order is stable (inbound, snapshot
  // outbound order, history extras), so new keys always land at the end and the
  // positional setData arrays stay aligned with uPlot series order.
  useEffect(() => {
    const inst = uplotInstance.current;
    if (!inst) return;
    const nextKeys = seriesMetaList.map((s) => s.key);
    const applied = appliedKeysRef.current;
    if (applied.join(",") === nextKeys.join(",")) return;

    const removeIdx: number[] = [];
    applied.forEach((key, i) => {
      if (!nextKeys.includes(key)) removeIdx.push(i + 1); // series[0] is x
    });
    removeIdx
      .sort((a, b) => b - a)
      .forEach((idx) => inst.delSeries(idx));

    const metaByKey = new Map(seriesMetaList.map((s) => [s.key, s]));
    for (const key of nextKeys) {
      if (!applied.includes(key)) {
        const meta = metaByKey.get(key)!;
        inst.addSeries({
          label: meta.label,
          stroke: meta.color,
          width: 2,
          fill: `${meta.color}15`,
          points: { show: false },
          spanGaps: true,
        });
      }
    }
    appliedKeysRef.current = nextKeys;
  }, [seriesMetaList]);

  useEffect(() => {
    const inst = uplotInstance.current;
    if (!inst) return;

    inst.setData(chartData, false);

    if (isLive) {
      const times = chartData[0];
      if (times && times.length > 0) {
        const latest = times[times.length - 1]!;
        if (windowSec === "all") {
          const earliest = times[0]!;
          inst.setScale("x", { min: earliest, max: latest });
        } else {
          inst.setScale("x", { min: latest - windowSec, max: latest });
        }
      }
    }
  }, [chartData, isLive, windowSec]);

  const handleWindowSelect = (sec: number | "all") => {
    setWindowSec(sec);
    setIsLive(true);
    const inst = uplotInstance.current;
    if (inst) {
      const times = chartData[0];
      if (times && times.length > 0) {
        const latest = times[times.length - 1]!;
        if (sec === "all") {
          const earliest = times[0]!;
          inst.setScale("x", { min: earliest, max: latest });
        } else {
          inst.setScale("x", { min: latest - sec, max: latest });
        }
      }
    }
  };

  const handleLiveClick = () => {
    setIsLive(true);
    const inst = uplotInstance.current;
    if (inst) {
      const times = chartData[0];
      if (times && times.length > 0) {
        const latest = times[times.length - 1]!;
        if (windowSec === "all") {
          const earliest = times[0]!;
          inst.setScale("x", { min: earliest, max: latest });
        } else {
          inst.setScale("x", { min: latest - windowSec, max: latest });
        }
      }
    }
  };

  const handlePlotDoubleClick = () => {
    handleLiveClick();
  };

  return (
    <div className="stream-chart-card" ref={containerRef}>
      <div className="stream-chart-header">
        <div className="stream-chart-legend">
          <span className="stream-chart-eyebrow">Bandwidth</span>
          {legendItems.map(({ meta, current }) => (
            <span key={meta.key} className="stream-chart-legend-item">
              <span className="stream-chart-legend-dot" style={{ backgroundColor: meta.color }} />
              <span className="stream-chart-legend-label">{meta.label}</span>
              <span className="stream-chart-legend-val">{formatBitrate(current)}</span>
            </span>
          ))}
        </div>
        <div className="stream-chart-controls">

          <div className="chart-btn-group">
            <button
              type="button"
              className={`chart-btn ${windowSec === 120 ? "active" : ""}`}
              onClick={() => handleWindowSelect(120)}
            >
              2m
            </button>
            <button
              type="button"
              className={`chart-btn ${windowSec === 300 ? "active" : ""}`}
              onClick={() => handleWindowSelect(300)}
            >
              5m
            </button>
            <button
              type="button"
              className={`chart-btn ${windowSec === 600 ? "active" : ""}`}
              onClick={() => handleWindowSelect(600)}
            >
              10m
            </button>
            <button
              type="button"
              className={`chart-btn ${windowSec === 1800 ? "active" : ""}`}
              onClick={() => handleWindowSelect(1800)}
            >
              30m
            </button>
            <button
              type="button"
              className={`chart-btn ${windowSec === 3600 ? "active" : ""}`}
              onClick={() => handleWindowSelect(3600)}
            >
              1h
            </button>
            <button
              type="button"
              className={`chart-btn ${windowSec === "all" ? "active" : ""}`}
              onClick={() => handleWindowSelect("all")}
            >
              All
            </button>
          </div>

          <button
            type="button"
            className={`chart-live-btn ${isLive ? "live-active" : "live-paused"}`}
            onClick={handleLiveClick}
            title={isLive ? "Real-time auto-follow active" : "Auto-follow paused. Click to return to Live"}
          >
            <span className="chart-live-dot"></span>
            <span>{isLive ? "LIVE" : "PAUSED"}</span>
          </button>
        </div>
      </div>

      <div className="stream-chart-plot-wrap" onDoubleClick={handlePlotDoubleClick}>
        <div ref={plotRef} className="uplot-wrapper" />
        <div ref={tooltipRef} className="chart-tooltip" style={{ display: "none" }} />
      </div>
    </div>
  );
}
