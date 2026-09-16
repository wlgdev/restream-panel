import type { AppConfig } from "../config";

export function createAuthMiddleware(config: AppConfig) {
  return async (request: Request): Promise<Response | null> => {
    const authHeader = request.headers.get("Authorization");

    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Restream Panel"',
        },
      });
    }

    const encoded = authHeader.slice(6);
    const decoded = atob(encoded);
    const [username, password] = decoded.split(":");

    if (username !== config.auth.username || password !== config.auth.password) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Restream Panel"',
        },
      });
    }

    return null;
  };
}
