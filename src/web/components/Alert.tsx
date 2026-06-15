import React, { useEffect } from "react";

interface AlertProps {
  type: "success" | "error" | "warning";
  message: string;
  onClose: () => void;
}

const ALERT_ICONS: Record<string, string> = {
  success: "✓",
  error: "✕",
  warning: "⚠",
};

export function Alert({ type, message, onClose }: AlertProps) {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`alert alert-${type}`}>
      <span className="alert-icon">{ALERT_ICONS[type]}</span>
      <span className="alert-message">{message}</span>
      <button className="alert-close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
