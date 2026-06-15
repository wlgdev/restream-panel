import React from "react";

interface HeaderProps {
  status: { running: boolean; version: string };
  appCount: number;
  onReload: () => void;
}

export function Header({ status, appCount, onReload }: HeaderProps) {
  return (
    <header className="header">
      <div className="container">
        <div className="header-content">
          <div className="header-brand">
            <svg
              className="header-logo"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
              <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" />
              <circle cx="12" cy="12" r="2" />
              <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" />
              <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
            </svg>
            <div>
              <h1>Restream Panel</h1>
              <div className="header-meta">
                {appCount} app{appCount !== 1 ? "s" : ""} configured
              </div>
            </div>
          </div>
          <div className="header-actions">
            <div className="version-badge" title="Panel version">
              {typeof VERSION === "undefined" ? "dev" : VERSION}
            </div>
            <div className={`status-badge ${status.running ? "running" : ""}`}>
              <div className="status-dot" />
              <span>{status.running ? `nginx ${status.version}` : "nginx stopped"}</span>
            </div>
            <button className="btn btn-secondary btn-small" onClick={onReload}>
              Reload
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
