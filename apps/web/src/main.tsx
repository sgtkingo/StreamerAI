import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AdminApp } from "./components/AdminApp";
import { ToastProvider } from "./components/ToastProvider";
import "./styles.css";
import "./deployment.css";
import "./admin.css";
import { UpdateNotice } from "./components/UpdateNotice";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <UpdateNotice />
      {window.location.pathname === "/admin" ||
      window.location.pathname.startsWith("/admin/") ? (
        <AdminApp />
      ) : (
        <App />
      )}
    </ToastProvider>
  </React.StrictMode>,
);
