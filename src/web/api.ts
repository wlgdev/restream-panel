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

export async function getStatus() {
  return request<{ status: { app: { ip: string } } }>("/system/status");
}

