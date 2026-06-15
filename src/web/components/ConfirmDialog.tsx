import React from "react";

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div>
      <div className="confirm-body">
        <span className="confirm-icon">⚠</span>
        <p className="confirm-message">{message}</p>
      </div>
      <div className="confirm-actions">
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={onConfirm}>
          Delete
        </button>
      </div>
    </div>
  );
}
