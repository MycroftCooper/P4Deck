import { createRoot } from "react-dom/client";
import { runtime } from "./branch-stubs";
import "../../app/styles/tokens.css";
import "../../app/styles/workbench.css";
import "../../app/styles/branch-mappings.css";
if ("__TAURI_INTERNALS__" in window) throw new Error("Native bridge forbidden");
const baseline = new URLSearchParams(location.search).has("baseline");
const { BranchMappingsPage } = baseline
  // @ts-expect-error Dedicated Vite plugin loads the saved 0.1.2 source only.
  ? await import("audit-branch-baseline")
  : await import("../../../src/features/browsers/components/BranchMappingsPage");
createRoot(document.getElementById("root")!).render(<BranchMappingsPage runtime={runtime} zh={true} />);
