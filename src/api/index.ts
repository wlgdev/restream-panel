import type { AppConfig } from "../config";
import type { MonitorManager } from "../monitor/monitor-manager";
import type { BandwidthPoint } from "../core/types";
import type { MonitorFrame } from "../monitor/types";
import { createAuthMiddleware } from "./auth";

// Detect if running from source (.ts) or binary
const isRunningFromSource = Bun.main.endsWith(".ts");

let embedded: { EMBEDDED_HTML: string; EMBEDDED_CSS: string; EMBEDDED_JS: string } | null = null;

if (!isRunningFromSource) {
  try {
    embedded = require("../embedded");
  } catch {}
}

function serveEmbedded(content: string, contentType: string): Response {
  return new Response(content, { headers: { "Content-Type": contentType } });
}

async function serveFile(path: string, contentType: string): Promise<Response> {
  const file = Bun.file(path);
  if (await file.exists()) {
    return new Response(file, { headers: { "Content-Type": contentType } });
  }
  return new Response("Not found", { status: 404 });
}

const serveIndex = async () => {
  if (embedded) return serveEmbedded(embedded.EMBEDDED_HTML, "text/html");
  return serveFile("./public/index.html", "text/html");
};

const SSE_INTERVAL_MS = 5000;

// recordPoint coalesces points landing within 2s into the last point by
// mutating it in place — so a point the client already received may gain
// fresher values. Re-sending this tail overlap lets clients upsert by time
// and stay exact instead of keeping a stale copy of the mutated point.
const BW_TAIL_OVERLAP_SEC = 3;

function maxBandwidthTime(bandwidth: Record<string, BandwidthPoint[]>): number {
  let max = 0;
  for (const points of Object.values(bandwidth)) {
    for (const point of points) {
      if (point.time > max) max = point.time;
    }
  }
  return max;
}

export interface ApiServerOptions {
  tls?: { key: Bun.BunFile; cert: Bun.BunFile };
}

export function createApiServer(
  config: AppConfig,
  manager: MonitorManager,
  serveOptions: ApiServerOptions = {},
) {
  const checkAuth = createAuthMiddleware(config);

  return Bun.serve({
    port: config.port,
    ...serveOptions,
    routes: {
      "/": serveIndex,
      "/monitor": serveIndex,
      "/styles.css": async () => {
        if (embedded) return serveEmbedded(embedded.EMBEDDED_CSS, "text/css");
        return serveFile("./public/styles.css", "text/css");
      },
      "/main.js": async () => {
        if (embedded) return serveEmbedded(embedded.EMBEDDED_JS, "application/javascript");
        return serveFile("./public/main.js", "application/javascript");
      },
      "/api/system/status": async (request) => {
        const denied = await checkAuth(request);
        if (denied) return denied;
        return Response.json({
          success: true,
          status: { app: { ip: config.ip } },
        });
      },
      // Live monitor feed, one frame every tick. The first frame of a
      // connection is a full snapshot; the rest are deltas (fresh bandwidth
      // points + fresh events, streams/orphans/errors stay full — they are
      // small). A reconnect starts over with a full frame, so the client
      // never needs to track sync state in the URL.
      // Public like the old polling endpoint (Login gates the UI client-side);
      // EventSource cannot send Authorization headers, so auth stays out here.
      "/api/monitor/stream": () => {
        let timer: ReturnType<typeof setInterval> | null = null;
        let first = true;
        let lastBwTime = 0;
        let lastEventSeq = 0;
        const stream = new ReadableStream({
          start(controller) {
            const send = () => {
              try {
                const snapshot = manager.getSnapshot();
                let frame: MonitorFrame;
                if (first) {
                  first = false;
                  frame = { ...snapshot, full: true, bandwidthKeys: manager.getBandwidthKeys() };
                  lastBwTime = maxBandwidthTime(snapshot.bandwidth);
                  for (const event of snapshot.events) {
                    if (event.seq > lastEventSeq) lastEventSeq = event.seq;
                  }
                } else {
                  const bandwidth = manager.getBandwidthSince(lastBwTime - BW_TAIL_OVERLAP_SEC);
                  const events = manager.getEventsSince(lastEventSeq);
                  frame = {
                    streams: snapshot.streams,
                    orphans: snapshot.orphans,
                    events,
                    bandwidth,
                    errors: snapshot.errors,
                    timestamp: snapshot.timestamp,
                    full: false,
                    bandwidthKeys: manager.getBandwidthKeys(),
                  };
                  const tailMax = maxBandwidthTime(bandwidth);
                  if (tailMax > lastBwTime) lastBwTime = tailMax;
                  for (const event of events) {
                    if (event.seq > lastEventSeq) lastEventSeq = event.seq;
                  }
                }
                controller.enqueue(`data: ${JSON.stringify(frame)}\n\n`);
              } catch {
                // Client gone mid-write; cancel() cleans up the timer.
              }
            };
            send();
            timer = setInterval(send, SSE_INTERVAL_MS);
          },
          cancel() {
            if (timer) clearInterval(timer);
            timer = null;
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
    fetch() {
      return new Response("Not found", { status: 404 });
    },
    error(error) {
      console.error("API Error:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}
