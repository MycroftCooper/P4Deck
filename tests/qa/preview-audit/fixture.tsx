import { createRoot } from "react-dom/client";
import type { RuntimeInfo } from "../../../src/shared/contracts";
import "./fixture.css";
if ("__TAURI_INTERNALS__" in window) throw new Error("Native bridge forbidden");
const params = new URLSearchParams(location.search);
const baseline = params.has("baseline");
if (baseline) await import("./preview-baseline.css");
else await import("../../../src/app/styles/preview.css");
const { FilePreviewPage } = baseline
  // @ts-expect-error Isolated Vite alias loads the archived source without infrastructure.
  ? await import("audit-preview-baseline")
  : await import("../../../src/features/browsers/components/FilePreviewPage");
if (params.has("zero")) Object.assign(document.getElementById("root")!.style, { width: "0px", height: "0px", overflow: "hidden" });
createRoot(document.getElementById("root")!).render(
  <FilePreviewPage
    target="synthetic.json"
    runtime={{ mode: "mock" } as RuntimeInfo}
    locked={false}
    onTargetChange={() => {}}
    zh={true}
  />,
);
