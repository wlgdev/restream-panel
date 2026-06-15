import React, { useState, useEffect } from "react";
import type { Server, PushTarget } from "../types";

interface ApplicationFormProps {
  servers: Server[];
  existingNames: string[];
  initialName?: string;
  initialTargets?: PushTarget[];
  onSubmit: (name: string, pushTargets: { serverId: string; streamKey: string }[]) => void;
  onCancel: () => void;
}

export function ApplicationForm({
  servers,
  existingNames,
  initialName = "",
  initialTargets = [],
  onSubmit,
  onCancel,
}: ApplicationFormProps) {
  const [name, setName] = useState(initialName);
  const [selectedTargets, setSelectedTargets] = useState<Map<string, string>>(new Map());
  const [nameError, setNameError] = useState("");
  // We'll calculate targets error dynamically to simpler state management, but keep state for explicit messages if needed.
  // Actually, deriving validity is cleaner.

  useEffect(() => {
    if (initialTargets.length > 0) {
      const targets = new Map<string, string>();
      for (const t of initialTargets) {
        targets.set(t.serverId, t.streamKey);
      }
      setSelectedTargets(targets);
    }
  }, []);

  const validateName = (value: string): string => {
    if (!value) return "";
    if (!/^[a-zA-Z0-9_]+$/.test(value)) return "Only letters, numbers, underscores";
    if (value.length > 64) return "Max 64 characters";
    if (existingNames.includes(value)) return "Name already exists";
    return "";
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setNameError(validateName(value));
  };

  const toggleServer = (serverId: string) => {
    const next = new Map(selectedTargets);
    if (next.has(serverId)) {
      next.delete(serverId);
    } else {
      next.set(serverId, "");
    }
    setSelectedTargets(next);
  };

  const updateStreamKey = (serverId: string, key: string) => {
    const next = new Map(selectedTargets);
    next.set(serverId, key);
    setSelectedTargets(next);
  };

  // Check validity
  const isNameValid = name.length > 0 && !nameError;
  const hasTargets = selectedTargets.size > 0;

  // Validation: If > 1 target, all must have stream keys
  let targetsError = "";
  if (selectedTargets.size > 1) {
    const missingKeys = Array.from(selectedTargets.values()).filter((k) => !k || k.trim() === "").length;
    if (missingKeys > 0) {
      targetsError = "Stream keys are required for all targets when multiple are selected.";
    }
  }

  const isValid = isNameValid && hasTargets && !targetsError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    const pushTargets = Array.from(selectedTargets.entries()).map(([serverId, streamKey]) => ({
      serverId,
      streamKey,
    }));

    onSubmit(name, pushTargets);
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-group">
        <label className="form-label">Application Name</label>
        <input
          type="text"
          className={`form-input ${nameError ? "invalid" : name && !nameError ? "valid" : ""}`}
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="my_stream"
          disabled={!!initialName}
          autoFocus={!initialName}
        />
        {nameError && (
          <div
            style={{
              color: "var(--danger)",
              fontSize: "0.6875rem",
              fontFamily: "var(--font-mono)",
              marginTop: "0.375rem",
            }}
          >
            {nameError}
          </div>
        )}
      </div>

      <div className="form-group">
        <label className="form-label">Target Servers</label>
        <div className="server-selector">
          {servers.map((server) => {
            const isSelected = selectedTargets.has(server.id);
            const key = selectedTargets.get(server.id) || "";
            // Highlight empty keys if required
            const isKeyInvalid = targetsError && isSelected && (!key || key.trim() === "");

            return (
              <div key={server.id}>
                <div
                  className={`server-option ${isSelected ? "selected" : ""}`}
                  onClick={() => toggleServer(server.id)}
                >
                  <input type="checkbox" checked={isSelected} onChange={() => {}} />
                  <div className="server-info">
                    <div className="server-name">{server.name}</div>
                    <div className="server-url">{server.url}</div>
                  </div>
                </div>
                {isSelected && (
                  <div style={{ padding: "0.5rem 0 0.5rem 2rem" }}>
                    <input
                      type="text"
                      className={`form-input ${isKeyInvalid ? "invalid" : ""}`}
                      placeholder={targetsError ? "Stream key required" : "Stream key (leave empty for dynamic)"}
                      value={key}
                      onChange={(e) => updateStreamKey(server.id, e.target.value)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {targetsError && (
          <div
            style={{
              color: "var(--danger)",
              fontSize: "0.6875rem",
              fontFamily: "var(--font-mono)",
              marginTop: "0.75rem",
              textAlign: "right",
            }}
          >
            {targetsError}
          </div>
        )}
      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!isValid}>
          {initialName ? "Save Changes" : "Create"}
        </button>
      </div>
    </form>
  );
}
