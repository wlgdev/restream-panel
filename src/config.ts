export interface AppConfig {
  port: number;
  nginxConfigPath: string;
  auth: {
    username: string;
    password: string;
  };
  ip: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 16969,
  nginxConfigPath: process.platform === "win32" ? "./mocks/nginx.conf" : "/etc/nginx/nginx.conf",
  auth: {
    username: "admin",
    password: "restream",
  },
  ip: "localhost",
};

export function parseArgs(): Partial<AppConfig> {
  const args = process.argv.slice(2);
  const config: Partial<AppConfig> = {};
  let authPartial: { username?: string; password?: string } = {};

  for (const arg of args) {
    if (arg.startsWith("--port=")) {
      const port = parseInt(arg.split("=")[1] ?? "", 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        config.port = port;
      }
    }
    if (arg.startsWith("--config=")) {
      const path = arg.split("=")[1];
      if (path) {
        config.nginxConfigPath = path;
      }
    }
    if (arg.startsWith("--user=")) {
      const username = arg.split("=")[1];
      if (username) {
        authPartial.username = username;
      }
    }
    if (arg.startsWith("--password=")) {
      const password = arg.split("=")[1];
      if (password) {
        authPartial.password = password;
      }
    }
    if (arg.startsWith("--ip=")) {
      const ip = arg.split("=")[1];
      if (ip) {
        config.ip = ip;
      }
    }
  }

  if (process.env.RESTREAM_PORT) {
    const port = parseInt(process.env.RESTREAM_PORT, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      config.port = port;
    }
  }
  if (process.env.RESTREAM_CONFIG) {
    config.nginxConfigPath = process.env.RESTREAM_CONFIG;
  }
  if (process.env.RESTREAM_USER) {
    authPartial.username = process.env.RESTREAM_USER;
  }
  if (process.env.RESTREAM_PASSWORD) {
    authPartial.password = process.env.RESTREAM_PASSWORD;
  }
  if (process.env.RESTREAM_IP) {
    config.ip = process.env.RESTREAM_IP;
  }

  if (authPartial.username || authPartial.password) {
    config.auth = {
      username: authPartial.username ?? DEFAULT_CONFIG.auth.username,
      password: authPartial.password ?? DEFAULT_CONFIG.auth.password,
    };
  }

  return config;
}

export function loadConfig(): AppConfig {
  const args = parseArgs();

  return {
    port: args.port ?? DEFAULT_CONFIG.port,
    nginxConfigPath: args.nginxConfigPath ?? DEFAULT_CONFIG.nginxConfigPath,
    auth: args.auth ?? DEFAULT_CONFIG.auth,
    ip: args.ip ?? DEFAULT_CONFIG.ip,
  };
}
