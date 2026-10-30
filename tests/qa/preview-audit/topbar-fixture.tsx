import { createRoot } from "react-dom/client";
import { TopBar } from "../../../src/app/shell/TopBar";
import { runtime } from "./branch-stubs";
import "../../app/styles/tokens.css";
import "../../app/styles/workbench.css";
import "../../app/styles/commands.css";
import "../../app/styles/workspace-switcher.css";
if ("__TAURI_INTERNALS__" in window) throw new Error("Native bridge forbidden");
createRoot(document.getElementById("root")!).render(<div className="app-shell">
  <TopBar runtime={runtime} zh onRuntime={() => {}} onSettings={() => { document.body.dataset.settingsOpened = "true"; }} />
  <nav style={{ padding: 8 }}>合成导航：文件 · 待提交 · 已提交 · 设置</nav>
  <main style={{ minHeight: 0, background: "var(--panel)" }}>合成内容区域 — 本页不执行应用或连接操作</main>
  <div>合成工具区</div><footer>布局验收</footer>
</div>);
