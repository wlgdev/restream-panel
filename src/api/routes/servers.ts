import { Elysia } from "elysia";
import type { ConfigService } from "../../services/configService";

export function createServersRoutes(configService: ConfigService) {
  return (
    new Elysia({ prefix: "/api/servers" })
      .get("/", () => {
        const servers = configService.getTargetServers();

        return {
          servers: servers.map((server) => ({
            id: server.id,
            name: server.name,
            url: server.url,
            requiresStreamKey: server.requiresStreamKey,
            supportsDynamicStreamKey: server.supportsDynamicStreamKey ?? false,
          })),
        };
      })
  );
}
