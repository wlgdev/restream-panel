import { Elysia, t } from "elysia";
import type { ConfigService } from "../../services/configService";

export function createApplicationsRoutes(configService: ConfigService) {
  return (
    new Elysia({ prefix: "/api/applications" })
      .get("/", async ({ set }) => {
        const [applicationsResult, streamTargetsResult] = await Promise.all([
          configService.getApplications(),
          configService.getConfiguredStreamTargets(),
        ]);

        if (!applicationsResult.success) {
          set.status = 500;
          return { error: applicationsResult.error };
        }

        if (!streamTargetsResult.success) {
          set.status = 500;
          return { error: streamTargetsResult.error };
        }

        return {
          applications: applicationsResult.data?.map((app) => ({
            name: app.name,
            isProtected: app.isProtected,
            pushTargets: app.pushTargets.map((target) => ({
              serverId: target.server.id,
              serverName: target.server.name,
              serverUrl: target.server.url,
              streamKey: target.streamKey,
            })),
          })),
          streamTargets: streamTargetsResult.data ?? [],
        };
      })

      .get(
        "/:name",
        async ({ params, set }) => {
          const result = await configService.getApplication(params.name);

          if (!result.success) {
            set.status = 404;
            return { error: result.error };
          }

          const app = result.data!;
          return {
            application: {
              name: app.name,
              isProtected: app.isProtected,
              pushTargets: app.pushTargets.map((target) => ({
                serverId: target.server.id,
                serverName: target.server.name,
                serverUrl: target.server.url,
                streamKey: target.streamKey,
              })),
            },
          };
        },
        {
          params: t.Object({
            name: t.String(),
          }),
        },
      )

      .post(
        "/",
        async ({ body, set }) => {
          const result = await configService.addApplication({
            name: body.name,
            pushTargets: body.pushTargets,
          });

          if (!result.success) {
            set.status = result.error?.includes("already exists") ? 409 : 400;
            return { error: result.error };
          }

          set.status = 201;
          return {
            success: true,
            application: {
              name: result.data!.name,
              isProtected: result.data!.isProtected,
              pushTargets: result.data!.pushTargets.map((target) => ({
                serverId: target.server.id,
                serverName: target.server.name,
                serverUrl: target.server.url,
                streamKey: target.streamKey,
              })),
            },
          };
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_]+$" }),
            pushTargets: t.Array(
              t.Object({
                serverId: t.String(),
                streamKey: t.String(),
              }),
              { minItems: 1 },
            ),
          }),
        },
      )

      .put(
        "/:name",
        async ({ params, body, set }) => {
          const result = await configService.updateApplication(params.name, {
            name: body.name,
            pushTargets: body.pushTargets,
          });

          if (!result.success) {
            if (result.error?.includes("not found")) {
              set.status = 404;
            } else if (result.error?.includes("protected")) {
              set.status = 403;
            } else if (result.error?.includes("already exists")) {
              set.status = 409;
            } else {
              set.status = 400;
            }
            return { error: result.error };
          }

          return {
            success: true,
            application: {
              name: result.data!.name,
              isProtected: result.data!.isProtected,
              pushTargets: result.data!.pushTargets.map((target) => ({
                serverId: target.server.id,
                serverName: target.server.name,
                serverUrl: target.server.url,
                streamKey: target.streamKey,
              })),
            },
          };
        },
        {
          params: t.Object({
            name: t.String(),
          }),
          body: t.Object({
            name: t.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9_]+$" }),
            pushTargets: t.Array(
              t.Object({
                serverId: t.String(),
                streamKey: t.String(),
              }),
              { minItems: 1 },
            ),
          }),
        },
      )

      .delete(
        "/:name",
        async ({ params, set }) => {
          const result = await configService.deleteApplication(params.name);

          if (!result.success) {
            if (result.error?.includes("not found")) {
              set.status = 404;
            } else if (result.error?.includes("protected")) {
              set.status = 403;
            } else {
              set.status = 400;
            }
            return { error: result.error };
          }

          return { success: true };
        },
        {
          params: t.Object({
            name: t.String(),
          }),
        },
      )
  );
}
