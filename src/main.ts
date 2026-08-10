import { createApiServer } from "./api";
import { loadConfig } from "./config";
import { ConfigService } from "./services/configService";
import { NginxService } from "./services/nginxService";
import { StreamMonitor } from "./services/streamMonitor";
import { test_vk } from "../mocks/ss";
import { SrtMonitor } from "./services/srtMonitor";
import { srtAndForward1, srtAndForward2, srtAndForward3, srtAndForwardNull } from "../mocks/srt";
import { resolve, join } from "path";
import { StreamEventLog } from "./services/streamEventLog";

const config = loadConfig();
const nginxService = new NginxService();
const isRunningFromSource = Bun.main.endsWith(".ts");
const isLocalDevHost = config.ip === "localhost" || config.ip === "127.0.0.1";

const sharedEventLog = new StreamEventLog();

const srtMonitor = new SrtMonitor({
  useMockData: isRunningFromSource && isLocalDevHost,
  mockOutputs: [srtAndForward1, srtAndForward2, srtAndForward3],
  eventLog: sharedEventLog,
});
const streamMonitor = new StreamMonitor({
  useMockData: isRunningFromSource && isLocalDevHost,
  mockOutputs: [test_vk],
  forwardMapProvider: () => srtMonitor.getForwardMap(),
  eventLog: sharedEventLog,
});
streamMonitor.startBackgroundPolling();
srtMonitor.startBackgroundPolling();
// Resolve absolute path to avoid ambiguity (e.g. running from dist/ but thinking relative to src/)
// If config.nginxConfigPath is relative (e.g. "./nginx.conf"), it resolves against CWD.
const absoluteConfigPath = resolve(process.cwd(), config.nginxConfigPath);
const configService = new ConfigService(absoluteConfigPath);

let appCount = 0;
let loadResult: any = { success: false, data: null };

if (config.enableNginxConfig) {
  // Ensure config exists
  loadResult = await configService.loadConfig();
  if (!loadResult.success) {
    console.warn(`⚠️  Warning: Failed to load initial config from ${absoluteConfigPath}: ${loadResult.error}`);
  }

  // Validate nginx config on startup
  const validation = await nginxService.validateConfig();
  if (!validation.success) {
    console.error("❌ Invalid nginx configuration:");
    console.error(validation.error);
    process.exit(1);
  }
}

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

// Pass serveOptions (including TLS) to Elysia constructor via createApiServer
const app = createApiServer(config, configService, nginxService, streamMonitor, srtMonitor, serveOptions);

// Try to listen, handling EADDRINUSE
try {
  app.listen(config.port, () => {
    console.log("Starting Restream Panel...");
    console.log(`Version: ${typeof VERSION === "undefined" ? "dev" : VERSION}`);
    console.log(`Port: ${config.port}`);
    console.log(`Config path: ${absoluteConfigPath}`); // Log absolute path
    console.log(`IP: ${config.ip}`);

    if (protocol === "https") {
      console.log(`🔒 SSL Enabled using:`);
      console.log(`   Key: ${keyPath}`);
      console.log(`   Cert: ${certPath}`);
    }

    if (config.enableNginxConfig) {
      if (loadResult.success && loadResult.data) {
        appCount = loadResult.data.applications.length;
      }
      console.log(`Loaded ${appCount} applications`);
    } else {
      console.log(`NGINX Management is disabled (start with --nginx to enable)`);
    }

    console.log(`\n🚀 Restream Panel is running at ${protocol}://${config.ip}:${config.port}`);
    if (config.ip !== "localhost") {
      console.log(`   (Also accessible via ${protocol}://localhost:${config.port})`);
    }

    console.log("\nDefault credentials: admin / restream");
    console.log("Press Ctrl+C to stop the server");
  });
} catch (err: unknown) {
  // Note: Bun/Elysia app.listen might throw synchronously or reject.
}

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
  streamMonitor.stopAll();
  srtMonitor.stopAll();
  process.exit(0);
});
