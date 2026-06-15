import type { CombinedHealthSnapshot } from "./types";

const API_BASE = "/api";

let authToken = localStorage.getItem("restream_auth_token");

export function setCredentials(username?: string, password?: string) {
  if (!username || !password) {
    authToken = null;
    localStorage.removeItem("restream_auth_token");
  } else {
    authToken = btoa(`${username}:${password}`);
    localStorage.setItem("restream_auth_token", authToken);
  }
}

export function clearCredentials() {
  authToken = null;
  localStorage.removeItem("restream_auth_token");
}

let onAuthError: (() => void) | null = null;
export function setAuthErrorHandler(handler: () => void) {
  onAuthError = handler;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (authToken) {
    headers["Authorization"] = `Basic ${authToken}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...options?.headers,
    },
  });

  if (response.status === 401 && onAuthError) {
    onAuthError();
  }

  const data = await response.json().catch(() => ({ error: "Invalid response" }));

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data as T;
}

export async function getApplications() {
  return request<{ applications: any[]; streamTargets: { id: string }[] }>("/applications");
}

export async function getServers() {
  return request<{ servers: any[] }>("/servers");
}

export async function getStatus() {
  // Update return type to include app.ip
  return request<{ status: { nginx: { running: boolean; version: string }; app: { ip: string } } }>("/system/status");
}

export async function createApplication(name: string, pushTargets: { serverId: string; streamKey: string }[]) {
  return request("/applications", {
    method: "POST",
    body: JSON.stringify({ name, pushTargets }),
  });
}

export async function updateApplication(
  originalName: string,
  name: string,
  pushTargets: { serverId: string; streamKey: string }[],
) {
  return request(`/applications/${originalName}`, {
    method: "PUT",
    body: JSON.stringify({ name, pushTargets }),
  });
}

export async function deleteApplication(name: string) {
  return request(`/applications/${name}`, {
    method: "DELETE",
  });
}

export async function reloadNginx() {
  return request("/system/reload", {
    method: "POST",
  });
}

export async function getStreams(clientId: string, since?: number) {
  let url = `${API_BASE}/health/streams?client=${encodeURIComponent(clientId)}`;
  if (since !== undefined) {
    url += `&since=${since}`;
  }
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
  });
  return response.json() as Promise<CombinedHealthSnapshot>;
}

export async function disconnectClient(clientId: string) {
  return fetch(`${API_BASE}/health/streams/disconnect?client=${encodeURIComponent(clientId)}`, {
    method: "POST",
    keepalive: true,
  });
}
