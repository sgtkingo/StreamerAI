import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./components/ToastProvider";
import "./styles.css";
import "./deployment.css";
import { UpdateNotice } from "./components/UpdateNotice";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <UpdateNotice />
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
