import { spawnSync } from "bun";
import { existsSync } from "node:fs";
import { rtmpTestResult } from "../../mocks/rmtp-test";

export function rtmpTestService(query: Record<string, string | undefined>) {
  const isDev = Bun.main.endsWith(".ts");

  if (isDev) {
    return rtmpTestResult;
  }

  if (process.platform !== "linux") {
    throw new Error("This service can only run on Linux");
  }

  if (!existsSync("/usr/local/bin/rtmp-test")) {
    throw new Error("rtmp-test application not found");
  }

  const args: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      args.push(`--${key}=${value}`);
    }
  }

  const result = spawnSync(["/usr/local/bin/rtmp-test", ...args]);

  if (result.exitCode !== 0) {
    throw new Error(`rtmp-test failed: ${result.stderr?.toString()}`);
  }

  const stdout = result.stdout?.toString();
  if (!stdout) {
    throw new Error("rtmp-test returned no output");
  }

  try {
    return JSON.parse(stdout);
  } catch (e: any) {
    throw new Error(`Failed to parse rtmp-test output: ${e.message}`);
  }
}
