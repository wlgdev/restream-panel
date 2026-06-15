import React, { useState, useEffect, useCallback } from "react";
import { Header } from "../components/Header";
import { ApplicationCard } from "../components/ApplicationCard";
import { StreamTargetCard } from "../components/StreamTargetCard";
import { ApplicationForm } from "../components/ApplicationForm";
import { Modal } from "../components/Modal";
import { Alert } from "../components/Alert";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Application, Server, AlertState, StreamTarget } from "../types";
import * as api from "../api";
import { PROTECTED_STREAM_TARGETS } from "../../core/constants";

export function Dashboard() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [streamTargetIds, setStreamTargetIds] = useState<string[]>([]);
  const [status, setStatus] = useState({ running: false, version: "" });
  const [serverIp, setServerIp] = useState("");
  const [loading, setLoading] = useState(true);
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [editingApp, setEditingApp] = useState<Application | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const results = await Promise.allSettled([api.getApplications(), api.getServers(), api.getStatus()]);

      const appsResult = results[0];
      const serversResult = results[1];
      const statusResult = results[2];

      if (appsResult.status === "fulfilled") {
        setApplications(appsResult.value.applications || []);
        setStreamTargetIds((appsResult.value.streamTargets || []).map((target) => target.id));
      } else {
        console.error("Failed to load applications:", appsResult.reason);
        setAlert({ type: "error", message: "Failed to load applications" });
      }

      if (serversResult.status === "fulfilled") {
        setServers(serversResult.value.servers || []);
      }

      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value.status?.nginx || { running: false, version: "" });
        if (statusResult.value.status?.app?.ip) {
          setServerIp(statusResult.value.status.app.ip);
        } else {
          setServerIp(window.location.hostname);
        }
      }
    } catch (e) {
      console.error("Unexpected error loading data:", e);
      setAlert({ type: "error", message: "Failed to load data" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreate = async (name: string, pushTargets: { serverId: string; streamKey: string }[]) => {
    try {
      await api.createApplication(name, pushTargets);
      setAlert({ type: "success", message: `Application '${name}' created` });
      setShowCreateForm(false);
      await fetchData();
    } catch {
      setAlert({ type: "error", message: "Failed to create application" });
    }
  };

  const handleUpdate = async (name: string, pushTargets: { serverId: string; streamKey: string }[]) => {
    if (!editingApp) return;
    try {
      await api.updateApplication(editingApp.name, name, pushTargets);
      setAlert({ type: "success", message: `Application '${editingApp.name}' updated` });
      setEditingApp(null);
      await fetchData();
    } catch {
      setAlert({ type: "error", message: "Failed to update application" });
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await api.deleteApplication(confirmDelete);
      setAlert({ type: "success", message: `Application '${confirmDelete}' deleted` });
      setConfirmDelete(null);
      await fetchData();
    } catch {
      setAlert({ type: "error", message: "Failed to delete application" });
    }
  };

  const handleReload = async () => {
    try {
      await api.reloadNginx();
      setAlert({ type: "success", message: "Nginx reloaded" });
      const statusRes = await api.getStatus();
      setStatus(statusRes.status?.nginx || { running: false, version: "" });
    } catch {
      setAlert({ type: "error", message: "Failed to reload nginx" });
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
      </div>
    );
  }

  const customApps = applications.filter((a) => !a.isProtected);
  const protectedApps = applications.filter((a) => a.isProtected);
  const displayIp = serverIp || window.location.hostname;
  const streamTargets: StreamTarget[] = PROTECTED_STREAM_TARGETS.filter((target) =>
    streamTargetIds.includes(target.id),
  ).map((target) => ({
    id: target.id,
    name: target.name,
    listenPort: target.listenPort,
    proxyPass: target.proxyPass,
    obsPath: target.obsPath,
    transportLabel: target.transportLabel,
    protectedLabel: target.protectedLabel,
    targetServerName: target.targetServerName,
  }));
  const showCustomSection = customApps.length > 0;
  const showStreamTargetsSection = streamTargets.length > 0;
  const showProtectedSection = protectedApps.length > 0;
  const sectionLabelStyle = {
    margin: "1.5rem 0 0.75rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.625rem",
    color: "var(--text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
  };

  return (
    <>
      <Header status={status} appCount={applications.length} onReload={handleReload} />

      <div className="container">
        {alert && <Alert type={alert.type} message={alert.message} onClose={() => setAlert(null)} />}

        <div className="toolbar">
          <span className="toolbar-info">
            {applications.length} application{applications.length !== 1 ? "s" : ""} • {customApps.length} custom
          </span>
          <button className="btn btn-primary" onClick={() => setShowCreateForm(true)}>
            + New Application
          </button>
        </div>

        {showCustomSection && (
          <>
            <div style={{ ...sectionLabelStyle, marginTop: 0 }}>Custom</div>
            {customApps.map((app, i) => (
              <ApplicationCard
                key={app.name}
                application={app}
                index={i}
                serverIp={displayIp}
                onEdit={() => setEditingApp(app)}
                onDelete={() => setConfirmDelete(app.name)}
              />
            ))}
          </>
        )}

        {showStreamTargetsSection && (
          <>
            <div style={{ ...sectionLabelStyle, marginTop: showCustomSection ? sectionLabelStyle.margin : 0 }}>
              TCP Proxy
            </div>
            {streamTargets.map((streamTarget, i) => (
              <StreamTargetCard key={streamTarget.id} streamTarget={streamTarget} index={i} serverIp={displayIp} />
            ))}
          </>
        )}

        {showProtectedSection && (
          <>
            <div
              style={{
                ...sectionLabelStyle,
                marginTop: showCustomSection || showStreamTargetsSection ? sectionLabelStyle.margin : 0,
              }}
            >
              RTMP Protected
            </div>
            {protectedApps.map((app, i) => (
              <ApplicationCard key={app.name} application={app} index={customApps.length + i} serverIp={displayIp} />
            ))}
          </>
        )}

        {applications.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">📡</div>
            <div className="empty-state-text">No applications configured</div>
          </div>
        )}

        <footer className="footer">Restream Panel</footer>
      </div>

      {showCreateForm && (
        <Modal title="New Application" onClose={() => setShowCreateForm(false)}>
          <ApplicationForm
            servers={servers}
            existingNames={applications.map((a) => a.name)}
            onSubmit={handleCreate}
            onCancel={() => setShowCreateForm(false)}
          />
        </Modal>
      )}

      {editingApp && (
        <Modal title={`Edit: ${editingApp.name}`} onClose={() => setEditingApp(null)}>
          <ApplicationForm
            servers={servers}
            existingNames={applications.filter((a) => a.name !== editingApp.name).map((a) => a.name)}
            initialName={editingApp.name}
            initialTargets={editingApp.pushTargets}
            onSubmit={handleUpdate}
            onCancel={() => setEditingApp(null)}
          />
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete Application" onClose={() => setConfirmDelete(null)}>
          <ConfirmDialog
            message={`Are you sure you want to delete "${confirmDelete}"? This will remove it from the nginx configuration.`}
            onConfirm={handleDelete}
            onCancel={() => setConfirmDelete(null)}
          />
        </Modal>
      )}
    </>
  );
}
