import React, { useState } from "react";
import type { StreamTarget } from "../types";

interface StreamTargetCardProps {
  streamTarget: StreamTarget;
  index: number;
  serverIp: string;
}

export function StreamTargetCard({ streamTarget, index, serverIp }: StreamTargetCardProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const obsUrl = `rtmp://${serverIp}:${streamTarget.listenPort}/${streamTarget.obsPath}`;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(obsUrl);
      setCopiedUrl(true);
    } catch {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = obsUrl;
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
    <div className="card card-protected" style={{ animationDelay: `${index * 60}ms` }}>
      <div className="card-header">
        <div>
          <div className="card-title">
            {streamTarget.name}
            <span className="badge badge-protected">{streamTarget.transportLabel}</span>
            <span className="badge badge-protected">🔒 {streamTarget.protectedLabel}</span>
          </div>
          <div className="card-subtitle">OBS ingress endpoint on port {streamTarget.listenPort}</div>
        </div>
      </div>

      <div className="rtmp-link">
        <span className="rtmp-link-label">RTMP</span>
        <span className="rtmp-link-url">{obsUrl}</span>
        <button
          className={`btn btn-ghost btn-small rtmp-link-copy ${copiedUrl ? "copied" : ""}`}
          onClick={handleCopyUrl}
        >
          {copiedUrl ? "✓ Copied" : "Copy"}
        </button>
      </div>

      <div className="push-targets">
        <div className="push-target-item">
          <div className="push-target-server">
            <span className="push-target-server-icon">🟣</span>
            <span className="push-target-server-name">{streamTarget.targetServerName}</span>
          </div>
          <span className="push-target-key dynamic">dynamic key</span>
        </div>
      </div>
    </div>
  );
}
