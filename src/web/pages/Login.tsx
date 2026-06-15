import React, { useState } from "react";
import * as api from "../api";
import { Alert } from "../components/Alert";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError("Please fill out both fields.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      api.setCredentials(username, password);
      // Attempt to load status to verify credentials
      await api.getStatus();
      onLogin();
    } catch (err) {
      api.clearCredentials();
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "1.5rem" }}>
      <div className="card" style={{ width: "100%", maxWidth: "400px", padding: "2rem" }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <svg className="header-logo" style={{ width: "48px", height: "48px", margin: "0 auto 1rem", display: "block" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
            <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4"></path>
            <circle cx="12" cy="12" r="2"></circle>
            <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4"></path>
            <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>
          </svg>
          <h1 style={{ fontSize: "1.75rem" }}>Restream Panel</h1>
          <div className="header-meta" style={{ marginTop: "0.5rem" }}>Authentication required</div>
        </div>

        {error && <Alert type="error" message={error} onClose={() => setError("")} />}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          <div>
            <label className="form-label">Username</label>
            <input
              type="text"
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              disabled={loading}
              autoFocus
            />
          </div>
          <div>
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={loading}
            />
          </div>
          <button type="submit" className="btn btn-primary" style={{ marginTop: "0.5rem", width: "100%" }} disabled={loading}>
            {loading ? "Authenticating..." : "Login"}
          </button>
        </form>
      </div>
    </div>
  );
}
