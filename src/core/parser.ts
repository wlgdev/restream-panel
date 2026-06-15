import type { Application, NginxConfig, ParseResult, PushTarget, StreamTargetConfig } from "./types";
import { isProtectedApplication, NGINX_STREAM_FAILOVER_CONFIG, PROTECTED_STREAM_TARGETS, TARGET_SERVERS } from "./constants";

export function parseNginxConfig(content: string): ParseResult {
  try {
    const rtmpMatch = findBlock(content, "rtmp");
    if (!rtmpMatch) {
      return {
        success: false,
        error: "No rtmp block found in nginx.conf",
      };
    }

    const rtmpStartIndex = content.indexOf("rtmp");
    const headerContent = content.substring(0, rtmpStartIndex);

    const rtmpEndIndex = rtmpStartIndex + rtmpMatch.fullBlock.length;
    const streamTargets = parseStreamTargets(content);
    const footerContent = stripManagedStreamBlocks(content.substring(rtmpEndIndex));

    const rtmpContent = rtmpMatch.content;

    const serverMatch = findBlock(rtmpContent, "server");
    if (!serverMatch) {
      return {
        success: false,
        error: "No server block found in rtmp block",
      };
    }

    const serverContent = serverMatch.content;
    const stunnelComments = extractStunnelComments(serverContent);
    const applications = parseApplications(serverContent);

    return {
      success: true,
      config: {
        applications,
        streamTargets,
        headerContent,
        footerContent,
        stunnelComments,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse nginx.conf: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

function stripManagedStreamBlocks(content: string): string {
  let nextContent = content;

  for (const streamTarget of PROTECTED_STREAM_TARGETS) {
    const streamBlock = findManagedStreamBlock(nextContent, streamTarget.id);
    if (!streamBlock) {
      continue;
    }

    nextContent = `${nextContent.slice(0, streamBlock.startIndex)}${nextContent.slice(streamBlock.endIndex)}`.trimEnd();
  }

  return nextContent;
}

function findBlock(content: string, blockName: string): { content: string; fullBlock: string } | null {
  const blockStartRegex = new RegExp(`${blockName}\\s*\\{`, "g");
  const match = blockStartRegex.exec(content);

  if (!match) {
    return null;
  }

  const startIndex = match.index;
  const contentStartIndex = startIndex + match[0].length;

  let braceCount = 1;
  let currentIndex = contentStartIndex;

  while (braceCount > 0 && currentIndex < content.length) {
    const char = content[currentIndex];
    if (char === "{") {
      braceCount++;
    } else if (char === "}") {
      braceCount--;
    }
    currentIndex++;
  }

  const blockContent = content.substring(contentStartIndex, currentIndex - 1);
  const fullBlock = content.substring(startIndex, currentIndex);

  return {
    content: blockContent,
    fullBlock,
  };
}

function extractStunnelComments(serverContent: string): string {
  const lines = serverContent.split("\n");
  const stunnelLines: string[] = [];

  for (const line of lines) {
    if (line.includes("# stunnel")) {
      stunnelLines.push(line.trim());
    }
  }

  return stunnelLines.join("\n");
}

function parseApplications(serverContent: string): Application[] {
  const applications: Application[] = [];

  let searchIndex = 0;
  while (searchIndex < serverContent.length) {
    const appMatch = findBlockFrom(serverContent, "application", searchIndex);

    if (!appMatch) {
      break;
    }

    const nameMatch = appMatch.header.match(/application\s+(\w+)/);
    if (!nameMatch || !nameMatch[1]) {
      searchIndex = appMatch.endIndex;
      continue;
    }

    const name = nameMatch[1];
    const blockContent = appMatch.content;

    const application: Application = {
      name,
      isProtected: isProtectedApplication(name),
      pushTargets: parsePushTargets(blockContent),
    };

    applications.push(application);
    searchIndex = appMatch.endIndex;
  }

  return applications;
}

function parseStreamTargets(content: string): StreamTargetConfig[] {
  const streamTargets: StreamTargetConfig[] = [];

  for (const streamTarget of PROTECTED_STREAM_TARGETS) {
    if (findManagedStreamBlock(content, streamTarget.id)) {
      streamTargets.push({ id: streamTarget.id });
    }
  }

  return streamTargets;
}

function findManagedStreamBlock(
  content: string,
  streamTargetId: string,
): { startIndex: number; endIndex: number; fullBlock: string } | null {
  if (streamTargetId !== "twitch_failover_proxy") {
    return null;
  }

  const blockStartRegex = /stream\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = blockStartRegex.exec(content)) !== null) {
    const startIndex = match.index;
    const block = findBlock(content.slice(startIndex), "stream");
    if (!block) {
      continue;
    }

    if (
      block.fullBlock.includes(`listen ${NGINX_STREAM_FAILOVER_CONFIG.listen};`) &&
      block.fullBlock.includes(`proxy_pass ${NGINX_STREAM_FAILOVER_CONFIG.proxyPass};`)
    ) {
      return {
        startIndex,
        endIndex: startIndex + block.fullBlock.length,
        fullBlock: block.fullBlock,
      };
    }
  }

  return null;
}

function findBlockFrom(
  content: string,
  blockName: string,
  startIndex: number,
): { content: string; header: string; endIndex: number } | null {
  const blockStartRegex = new RegExp(`${blockName}\\s+\\w+\\s*\\{`, "g");
  blockStartRegex.lastIndex = startIndex;
  const match = blockStartRegex.exec(content);

  if (!match) {
    return null;
  }

  const matchStartIndex = match.index;
  const contentStartIndex = matchStartIndex + match[0].length;

  let braceCount = 1;
  let currentIndex = contentStartIndex;

  while (braceCount > 0 && currentIndex < content.length) {
    const char = content[currentIndex];
    if (char === "{") {
      braceCount++;
    } else if (char === "}") {
      braceCount--;
    }
    currentIndex++;
  }

  const blockContent = content.substring(contentStartIndex, currentIndex - 1);

  return {
    content: blockContent,
    header: match[0],
    endIndex: currentIndex,
  };
}

function parsePushTargets(blockContent: string): PushTarget[] {
  const pushTargets: PushTarget[] = [];

  const pushRegex = /push\s+([^;]+);/g;
  let match;

  while ((match = pushRegex.exec(blockContent)) !== null) {
    const fullUrl = match[1];

    if (!fullUrl) {
      continue;
    }

    const pushTarget = parsePushUrl(fullUrl.trim());
    if (pushTarget) {
      pushTargets.push(pushTarget);
    }
  }

  return pushTargets;
}

function parsePushUrl(fullUrl: string): PushTarget | null {
  for (const server of TARGET_SERVERS) {
    if (fullUrl.startsWith(server.url)) {
      const afterBaseUrl = fullUrl.substring(server.url.length);
      const streamKey = afterBaseUrl.startsWith("/") ? afterBaseUrl.substring(1) : afterBaseUrl;

      return {
        server,
        streamKey,
      };
    }
  }

  const rtmpMatch = fullUrl.match(/^rtmp:\/\/([^/]+)\/(.+)$/);
  if (rtmpMatch) {
    const host = rtmpMatch[1];
    const pathWithKey = rtmpMatch[2];

    if (host && pathWithKey) {
      const lastSlashIndex = pathWithKey.lastIndexOf("/");

      if (lastSlashIndex !== -1) {
        const path = pathWithKey.substring(0, lastSlashIndex);
        const streamKey = pathWithKey.substring(lastSlashIndex + 1);

        return {
          server: {
            id: `unknown_${host.replace(/[:.]/g, "_")}`,
            name: `Unknown (${host})`,
            url: `rtmp://${host}/${path}`,
            requiresStreamKey: true,
          },
          streamKey,
        };
      }
    }
  }

  return null;
}

export function getApplicationByName(config: NginxConfig, name: string): Application | undefined {
  return config.applications.find((app) => app.name === name);
}

export function applicationNameExists(config: NginxConfig, name: string): boolean {
  return config.applications.some((app) => app.name === name);
}
