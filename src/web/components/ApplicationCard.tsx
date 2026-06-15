import React, { useState } from "react";
import type { Application } from "../types";

interface ApplicationCardProps {
  application: Application;
  index: number;
  serverIp: string;
  onEdit?: () => void;
  onDelete?: () => void;
}

function getServiceIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("twitch")) return "🟣";
  if (lower.includes("vk")) return "🔵";
  if (lower.includes("youtube")) return "🔴";
  return "⚪";
}

export function ApplicationCard({ application, index, serverIp, onEdit, onDelete }: ApplicationCardProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const rtmpUrl = `rtmp://${serverIp}/${application.name}`;

  const handleCopyUrl = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedUrl(true);
    } catch (err) {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = value;
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        const successful = document.execCommand("copy");
        document.body.removeChild(textArea);

        if (successful) {
          setCopiedUrl(true);
        }
      } catch (fallbackErr) {
        console.error("Copy failed", fallbackErr);
      }
    }

    setTimeout(() => setCopiedUrl(false), 2000);
  };

  return (
    <div
      className={`card ${application.isProtected ? "card-protected" : "card-custom"}`}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="card-header">
        <div>
          <div className="card-title">
            {application.name}
            <span className={`badge ${application.isProtected ? "badge-protected" : "badge-custom"}`}>
              {application.isProtected ? "🔒 Protected" : "Custom"}
            </span>
          </div>
          <div className="card-subtitle">
            {application.pushTargets.length} target{application.pushTargets.length !== 1 ? "s" : ""}
          </div>
        </div>
        {!application.isProtected && (
          <div className="card-actions">
            <button className="btn btn-ghost btn-small" onClick={onEdit}>
              Edit
            </button>
            <button className="btn btn-danger btn-small" onClick={onDelete}>
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="rtmp-link">
        <span className="rtmp-link-label">RTMP</span>
        <span className="rtmp-link-url">{rtmpUrl}</span>
        <button
          className={`btn btn-ghost btn-small rtmp-link-copy ${copiedUrl ? "copied" : ""}`}
          onClick={() => handleCopyUrl(rtmpUrl)}
        >
          {copiedUrl ? "✓ Copied" : "Copy"}
        </button>
      </div>

      <div className="push-targets">
        {application.pushTargets.map((target, i) => (
          <div key={i} className="push-target-item">
            <div className="push-target-server">
              <span className="push-target-server-icon">{getServiceIcon(target.serverName)}</span>
              <span className="push-target-server-name">{target.serverName}</span>
            </div>
            <span className={`push-target-key ${!target.streamKey ? "dynamic" : ""}`}>
              {target.streamKey || "dynamic key"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
