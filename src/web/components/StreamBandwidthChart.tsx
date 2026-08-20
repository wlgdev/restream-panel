import React, { useEffect, useRef, useState, useMemo } from "react";
import uPlot from "uplot";
import type { StreamHealthItem } from "../types";

export interface BandwidthPoint {
  time: number;
  inboundBps: number | null;
  outbounds: Record<string, number>;
}

export interface StreamBandwidthSeriesMeta {
  key: string;
  label: string;
  target: string;
  color: string;
}

interface Props {
  streamId: string;
  history: BandwidthPoint[];
  inbound: StreamHealthItem | null;
  outbound: StreamHealthItem[];
}

function getTargetColor(target: string): string {
  switch (target.toUpperCase()) {
    case "INBOUND":
      return "#38bdf8";
    case "TWITCH":
      return "#c084fc";
    case "VK":
      return "#60a5fa";
    case "YOUTUBE":
      return "#f87171";
    case "OUTBOUND":
      return "#00ff88";
    case "UNKNOWN":
    default:
      return "#fbbf24";
  }
}

function targetLabel(target: string): string {
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

function formatBitrate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "0 kbps";
  }
  const units = ["kbps", "Mbps", "Gbps"];
  let rate = value / 1000;
  let index = 0;
  while (rate >= 1000 && index < units.length - 1) {
    rate /= 1000;
    index += 1;
  }
  return `${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)} ${units[index]}`;
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
      list.push({
        key: "inbound",
        label: "Inbound",
        target: "INBOUND",
        color: getTargetColor("INBOUND"),
      });
      keysSeen.add("inbound");
    }

    const outboundTargetCounts = new Map<string, number>();
    for (const item of outbound) {
      outboundTargetCounts.set(item.target, (outboundTargetCounts.get(item.target) ?? 0) + 1);
    }

    for (const item of outbound) {
      const key = `${item.target}_${item.peer_ip || item.protocol || "dest"}`;
      if (!keysSeen.has(key)) {
        keysSeen.add(key);
        const count = outboundTargetCounts.get(item.target) ?? 1;
        const disambiguation = count > 1 && item.peer_ip ? ` (${item.peer_ip.split(":").pop()})` : "";
        list.push({
          key,
          label: `${targetLabel(item.target)}${disambiguation}`,
          target: item.target,
          color: getTargetColor(item.target),
        });
      }
    }

    for (const point of history) {
      for (const key of Object.keys(point.outbounds)) {
        if (!keysSeen.has(key)) {
          keysSeen.add(key);
          const parts = key.split("_");
          const target = parts[0] || "OUTBOUND";
          list.push({
            key,
            label: targetLabel(target),
            target,
            color: getTargetColor(target),
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

  useEffect(() => {
    if (!plotRef.current || !containerRef.current) return;

    if (uplotInstance.current) {
      uplotInstance.current.destroy();
      uplotInstance.current = null;
    }

    const width = containerRef.current.clientWidth || 800;
    const height = 180;

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
              itemsHtml += `
                <div class="chart-tooltip-row">
                  <span class="chart-tooltip-dot" style="background-color: ${s.color};"></span>
                  <span class="chart-tooltip-name">${s.label}:</span>
                  <span class="chart-tooltip-val">${formatBitrate(val)}</span>
                </div>
              `;
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
  }, [seriesMetaList.map((s) => s.key).join(","), streamId]);

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
          {seriesMetaList.map((s) => (
            <div key={s.key} className="stream-chart-legend-item">
              <span className="stream-chart-legend-dot" style={{ backgroundColor: s.color }}></span>
              <span className="stream-chart-legend-label">{s.label}</span>
            </div>
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
