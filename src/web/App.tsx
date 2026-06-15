import React, { useState, useEffect } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Health } from "./pages/Health";
import { Login } from "./pages/Login";
import * as api from "./api";

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem("restream_auth_token"));

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);

    // Register global auth error handler
    api.setAuthErrorHandler(() => {
      api.clearCredentials();
      setIsAuthenticated(false);
    });

    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  if (!isAuthenticated) {
    return <Login onLogin={() => setIsAuthenticated(true)} />;
  }

  if (path === "/health") {
    return <Health />;
  }

  return <Dashboard />;
}
