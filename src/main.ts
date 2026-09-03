import { createApiServer } from "./api";
import { loadConfig } from "./config";
import { test_vk } from "../mocks/ss";
import { srtAndForward1, srtAndForward2, srtAndForward3 } from "../mocks/srt";
import { pathes } from "../mocks/srt";
import { join } from "path";
import { StreamEventLog } from "./monitor/event-log";
import { StreamBandwidthLog } from "./monitor/bandwidth-log";
import { RtmpGrouping } from "./monitor/grouping/rtmp-grouping";
import { SrtGrouping } from "./monitor/grouping/srt-grouping";
import { MonitorManager } from "./monitor/monitor-manager";

const config = loadConfig();
// Mock fixtures (no ss/mediamtx needed) are opt-in via `bun run dev:mock` / `start:mock`.
// A plain `bun run src/main.ts` always talks to the real local mediamtx — including on Windows.
const useMockData = process.env.MOCK === "1";

const sharedEventLog = new StreamEventLog();
const sharedBandwidthLog = new StreamBandwidthLog();

const srtGrouping = new SrtGrouping({
  useMockData,
  mockOutputs: [srtAndForward1, srtAndForward2, srtAndForward3],
  eventLog: sharedEventLog,
  streamBandwidthLog: sharedBandwidthLog,
  pathInfo: useMockData ? { useMockData, mockOutput: pathes } : undefined,
});
const rtmpGrouping = new RtmpGrouping({
  useMockData,
  mockOutputs: [test_vk],
  forwardMapProvider: () => srtGrouping.getForwardMap(),
  publishMapProvider: () => srtGrouping.getPublishMap(),
  eventLog: sharedEventLog,
  streamBandwidthLog: sharedBandwidthLog,
  tracks: srtGrouping,
});

const manager = new MonitorManager({
  rtmpGrouping,
  srtGrouping,
  eventLog: sharedEventLog,
  streamBandwidthLog: sharedBandwidthLog,
});
manager.startBackgroundPolling();

// Check for TLS certificate and key in the application directory
// Using process.cwd() as primary search location
const certDir = process.cwd();
const keyPath = join(certDir, "key.pem");
const certPath = join(certDir, "cert.pem");

let serveOptions: any = {};
let protocol = "http";

try {
  const keyExists = await Bun.file(keyPath).exists();
  const certExists = await Bun.file(certPath).exists();

  if (keyExists && certExists) {
    serveOptions = {
      tls: {
        key: Bun.file(keyPath),
        cert: Bun.file(certPath),
      },
    };
    protocol = "https";
  }
} catch (err) {
  console.warn("Error checking for SSL certificates:", err);
}

// Bun.serve binds synchronously and throws on EADDRINUSE.
let server: ReturnType<typeof createApiServer>;
try {
  server = createApiServer(config, manager, serveOptions);
} catch (err: unknown) {
  if ((err as any)?.code === "EADDRINUSE" || String(err).includes("EADDRINUSE")) {
    console.error(`\n❌ Error: Port ${config.port} is already in use!`);
    console.error(`   Please stop the other instance of Restream Panel (or check for 'bun' processes).`);
    console.error(`   Alternatively, use '--port=XXXX' to specify a different port.\n`);
    process.exit(1);
  }
  throw err;
}

console.log("Starting Restream Panel...");
console.log(`Version: ${typeof VERSION === "undefined" ? "dev" : VERSION}`);
console.log(`Port: ${config.port}`);
console.log(`IP: ${config.ip}`);

if (protocol === "https") {
  console.log(`🔒 SSL Enabled using:`);
  console.log(`   Key: ${keyPath}`);
  console.log(`   Cert: ${certPath}`);
}

console.log(`\n🚀 Restream Panel is running at ${protocol}://${config.ip}:${config.port}`);
if (config.ip !== "localhost") {
  console.log(`   (Also accessible via ${protocol}://localhost:${config.port})`);
}

console.log("\nDefault credentials: admin / restream");
console.log("Press Ctrl+C to stop the server");

// Global error handler for the process to catch binding errors if app.listen is async
process.on("uncaughtException", (err: any) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Error: Port ${config.port} is already in use!`);
    console.error(`   Please stop the other instance of Restream Panel (or check for 'bun' processes).`);
    console.error(`   Alternatively, use '--port=XXXX' to specify a different port.\n`);
    process.exit(1);
  }
  console.error("Uncaught exception:", err);
  process.exit(1);
});

// Handle unhandled promise rejections too
process.on("unhandledRejection", (err: any) => {
  if (err?.code === "EADDRINUSE" || err?.message?.includes("EADDRINUSE")) {
    console.error(`\n❌ Error: Port ${config.port} is already in use!`);
    console.error(`   Please stop the other instance of Restream Panel.`);
    process.exit(1);
  }
  console.error("Unhandled rejection:", err);
});

process.on("SIGINT", () => {
  console.log("\nStopping server...");
  manager.stopAll();
  server.stop();
  process.exit(0);
});
