import { Elysia } from "elysia";
import type { NginxService } from "../../services/nginxService";
import type { AppConfig } from "../../config";

export function createSystemRoutes(nginxService: NginxService, config: AppConfig) {
  return new Elysia({ prefix: "/api/system" })
    .get("/status", async () => {
      const result = await nginxService.getStatus();
      return {
        success: result.success,
        status: {
          nginx: result.data,
          app: {
            ip: config.ip,
          },
        },
        error: result.error,
      };
    })
    .post("/reload", async ({ set }) => {
      const result = await nginxService.reload();
      if (!result.success) {
        set.status = 500;
        return { error: result.error };
      }
      return { success: true };
    });
}
