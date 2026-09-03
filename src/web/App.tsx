import React, { useState, useEffect } from "react";
import { Monitor } from "./pages/Monitor";
import { Login } from "./pages/Login";
import * as api from "./api";

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem("restream_auth_token"));

  useEffect(() => {
    // Register global auth error handler
    api.setAuthErrorHandler(() => {
      api.clearCredentials();
      setIsAuthenticated(false);
    });
  }, []);

  if (!isAuthenticated) {
    return <Login onLogin={() => setIsAuthenticated(true)} />;
  }

  return <Monitor />;
}
