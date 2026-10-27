import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import "./app/styles.css";
import { StartupBoundary, StartupShell } from "./app/StartupShell";

const App = lazy(() =>
  import("./app/App").then((module) => ({ default: module.App })),
);

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
    <StartupBoundary>
      <Suspense fallback={<StartupShell />}>
        {workflowAudit && WorkflowAuditPage ? (
          <WorkflowAuditPage />
        ) : audit && MenuAuditPage ? (
          <MenuAuditPage />
        ) : (
          <App />
        )}
      </Suspense>
    </StartupBoundary>
  </React.StrictMode>,
);
