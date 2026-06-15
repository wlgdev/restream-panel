import { Elysia } from "elysia";
import type { AppConfig } from "../config";
import { createApplicationsRoutes } from "./routes/applications";
import { createServersRoutes } from "./routes/servers";
import { createSystemRoutes } from "./routes/system";
import type { ConfigService } from "../services/configService";
import type { NginxService } from "../services/nginxService";
import type { StreamMonitor } from "../services/streamMonitor";
import type { SrtMonitor } from "../services/srtMonitor";
import { rtmpTestService } from "../services/rtmpTestService";

// Detect if running from source (.ts) or binary
const isRunningFromSource = Bun.main.endsWith(".ts");

let embedded: { EMBEDDED_HTML: string; EMBEDDED_CSS: string; EMBEDDED_JS: string } | null = null;

if (!isRunningFromSource) {
  try {
    embedded = require("../embedded");
  } catch {}
}

const SKIP_AUTH = new Set([
  "/",
  "/health",
  "/api/health/streams",
  "/api/health/streams/disconnect",
  "/styles.css",
  "/main.js",
  "/favicon.ico",
]);

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

export function createApiServer(
  config: AppConfig,
  configService: ConfigService,
  nginxService: NginxService,
  streamMonitor: StreamMonitor,
  srtMonitor: SrtMonitor,
  serveOptions: any = {},
) {
  const app = new Elysia({ serve: serveOptions })
    .get("/health", async () => {
      if (embedded) return serveEmbedded(embedded.EMBEDDED_HTML, "text/html");
      return serveFile("./public/index.html", "text/html");
    })
    .get("/api/rtmptest/measure", ({ query, set }) => {
      try {
        return rtmpTestService(query as Record<string, string>);
      } catch (error: any) {
        set.status = 500;
        return { error: error.message };
      }
    })
    .get("/api/health/streams", async ({ query }) => {
      const clientId =
        typeof query.client === "string" && query.client.length > 0 ? query.client : "anonymous-health-client";
      await Promise.all([streamMonitor.touchClient(clientId), srtMonitor.touchClient(clientId)]);
      return {
        rtmp: streamMonitor.getSnapshot(),
        srt: srtMonitor.getSnapshot(),
        events: streamMonitor.getEventsSince(
          typeof query.since === "string" ? parseInt(query.since, 10) : undefined
        ),
      };
    })
    .post("/api/health/streams/disconnect", ({ query }) => {
      if (typeof query.client === "string" && query.client.length > 0) {
        streamMonitor.disconnectClient(query.client);
        srtMonitor.disconnectClient(query.client);
      }

      return { success: true };
    })
    .get("/styles.css", async () => {
      if (embedded) return serveEmbedded(embedded.EMBEDDED_CSS, "text/css");
      return serveFile("./public/styles.css", "text/css");
    })
    .get("/main.js", async () => {
      if (embedded) return serveEmbedded(embedded.EMBEDDED_JS, "application/javascript");
      return serveFile("./public/main.js", "application/javascript");
    })
    .get("/", async () => {
      if (embedded) return serveEmbedded(embedded.EMBEDDED_HTML, "text/html");
      return serveFile("./public/index.html", "text/html");
    })
    .onBeforeHandle(({ request, set }) => {
      const pathname = new URL(request.url).pathname;
      if (SKIP_AUTH.has(pathname)) return;

      const authHeader = request.headers.get("Authorization");

      if (!authHeader || !authHeader.startsWith("Basic ")) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const encoded = authHeader.slice(6);
      const decoded = atob(encoded);
      const [username, password] = decoded.split(":");

      if (username !== config.auth.username || password !== config.auth.password) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
    })
    .use(createApplicationsRoutes(configService))
    .use(createServersRoutes(configService))
    .use(createSystemRoutes(nginxService, config))
    .onError(({ error, code }) => {
      if (code === "NOT_FOUND") return;

      console.error("API Error:", error);

      if (code === "VALIDATION") {
        return { error: "Validation error", details: String(error) };
      }

      return { error: "Internal server error" };
    });

  return app;
}
