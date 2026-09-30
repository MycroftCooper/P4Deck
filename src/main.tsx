import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import { App } from "./app/App";
import "./app/styles.css";

const MenuAuditPage = import.meta.env.DEV
  ? lazy(() => import("./app/context-menu/MenuAuditPage"))
  : null;
const audit =
  import.meta.env.DEV && new URLSearchParams(location.search).has("menu-audit");
const WorkflowAuditPage = import.meta.env.DEV
  ? lazy(() => import("./app/dialogs/WorkflowAuditPage"))
  : null;
const workflowAudit =
  import.meta.env.DEV &&
  new URLSearchParams(location.search).has("workflow-audit");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p>Loading…</p>}>
      {workflowAudit && WorkflowAuditPage ? (
        <WorkflowAuditPage />
      ) : audit && MenuAuditPage ? (
        <MenuAuditPage />
      ) : (
        <App />
      )}
    </Suspense>
  </React.StrictMode>,
);
