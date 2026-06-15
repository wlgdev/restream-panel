import type { AppConfig } from "../../config";

const STATIC_PATHS = new Set(["/health", "/styles.css", "/main.js"]);

export function createAuthMiddleware(config: AppConfig) {
  return async (request: Request): Promise<Response | null> => {
    const pathname = new URL(request.url).pathname;

    if (STATIC_PATHS.has(pathname)) {
      return null;
    }

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
