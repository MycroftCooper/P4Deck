// Standalone synthetic-only entry. Does not load the application's Vite config.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { commandStubs, productFiles, i2ProductFiles } from '../batch-qa/boundaries.mjs';
const root = fileURLToPath(new URL(".", import.meta.url));
const repo = path.resolve(root, "../../..");
const stub = path.join(root, "stubs.tsx");
const batch = path.resolve(root, '../batch-qa');
const allowed = [
  root,
  batch,
  ...productFiles.map(name => path.join(repo, 'src', name)),
  ...i2ProductFiles.map(name => path.join(repo, 'src', name)),
  ...["scrollbars.css", "docking.css"].map(name => path.join(repo, "src/app/styles", name)),
  path.join(repo, "src/shared/i18n"),
  ...["features/changelists/components/PendingPage.tsx", "features/changelists/pendingFilterState.ts", "shared/lib/storage.ts", "shared/i18n.ts", "app/context-menu/useRecordSelection.ts"].map(name => path.join(repo, "src", name)),
  ...["features/settings/ConnectionSetupGate.tsx", "features/settings/connectionWizard.ts", "features/files/address.ts", "app/styles/dialogs.css"].map(name => path.join(repo, "src", name)),
  path.join(repo, "node_modules"),
  path.join(repo, "src/features/browsers/components/FilePreviewPage.tsx"),
  path.join(repo, "src/app/context-menu/FullTextSelection.tsx"),
  path.join(repo, "src/app/styles/preview.css"),
  ...["BranchMappingsPage.tsx", "branchMappingModel.ts"].map(name => path.join(repo, "src/features/browsers", name)),
  ...["ResizeHeader.tsx", "ResizableTable.tsx", "ColumnResizer.tsx", "useColumnWidths.ts"].map(name => path.join(repo, "src/app/context-menu", name)),
  path.join(repo, "src/app/styles/branch-mappings.css"),
  path.join(repo, "src/app/styles/tokens.css"),
  path.join(repo, "src/app/styles/workbench.css"),
  path.join(repo, "src/app/styles/commands.css"),
  path.join(repo, "src/app/styles/workspace-switcher.css"),
  path.join(repo, "src/app/shell/TopBar.tsx"),
];
export default defineConfig({
  root,
  plugins: [
    react(),
    {
      name: "synthetic-only-imports",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use(async (req,res,next) => {
          const route=req.url?.split('?')[0];
          if(!['/batch.html','/i2.html'].includes(route)) return next();
          const html=readFileSync(path.join(batch,'index.html'),'utf8').replace('/ @BATCH_ENTRY@','/@fs/'+path.join(batch,route==='/i2.html'?'i2-fixture.tsx':'toolbar-fixture.tsx').replaceAll('\\','/'));
          res.setHeader('Content-Type','text/html');
          res.end(await server.transformIndexHtml('/batch.html',html));
        });
      },
      resolveId(id, importer) {
        const from=importer?.replaceAll('\\','/').split('?')[0];
        if(from?.endsWith('/CompanySubmitDialog.tsx') && id==='../../infrastructure/backend')return path.join(batch,'i2-stubs.tsx');
        if ((from?.endsWith('/app/shell/CommandBar.tsx') && commandStubs.includes(id)) ||
            (from?.endsWith('/app/shell/ActivityBar.tsx') && ['../context-menu/ContextMenu','../context-menu/bindings'].includes(id)) ||
            (from?.endsWith('/app/shell/commandPolicy.ts') && ['../../features/files/selectionCommands','../../features/files/selection'].includes(id))) return path.join(batch,'command-stubs.tsx');
        if (importer?.includes("components/PendingPage.tsx") && (id.startsWith("./") || id.startsWith("../")) && !id.endsWith("/pendingFilterState") && !id.endsWith("/useRecordSelection") && !id.endsWith('/companySubmit/CompanySubmitDialog')) return path.join(batch, "i2-stubs.tsx");
        if (importer?.includes("ConnectionSetupGate.tsx") && ["@tauri-apps/api/core", "../../app/closeGuard", "../../infrastructure/backend", "./ConnectionProfilesCard", "../../app/shell/AppControls"].includes(id)) return path.join(root, "gate-stubs.tsx");
        if (id === "audit-preview-baseline") return path.join(repo, "src/features/browsers/components/FilePreviewPage.tsx") + "?previewBaseline";
        if (id.endsWith("/WorkspaceSwitcher") || id.endsWith("/app/closeGuard")) return stub;
        if (id === "audit-branch-baseline") return path.join(repo, "src/features/browsers/components/BranchMappingsPage.tsx") + "?auditBaseline";
        // Replace the only data boundary before any real infrastructure resolves.
        if (id === "../../infrastructure/backend" || id.includes("/shared/cache/") || id.endsWith("/BranchMappingMutationDialog")) return path.join(root, "branch-stubs.tsx");
        if (
          id.endsWith("/useFilePreview") ||
          id.endsWith("/useContentMenu") ||
          id.endsWith("/docking/chrome") ||
          id.endsWith("/context-menu/bindings")
        )
          return stub;
        if (
          /infrastructure|@tauri-apps|(?:^|\/)App(?:\.|$)|(?:^|\/)main(?:\.|$)/.test(
            id,
          )
        )
          throw new Error(`Forbidden audit import: ${id}`);
      },
      load(id) {
        const plain=path.normalize(id.split('?')[0]);
        if (path.isAbsolute(plain) && plain.replaceAll('\\','/').includes('/src/') && !allowed.some(p => plain===path.normalize(p) || ([root,batch,path.join(repo,'node_modules'),path.join(repo,'src/shared/i18n')].includes(p) && plain.startsWith(path.normalize(p).replace(/[\\/]$/, '')+path.sep)))) throw new Error(`Non-whitelisted source: ${id}`);
        if (id.endsWith("?previewBaseline")) return readFileSync(path.join(root, "preview-baseline.txt"), "utf8");
        if (id.endsWith("?auditBaseline")) return readFileSync(path.join(root, "branch-baseline.txt"), "utf8");
      },
    },
  ],
  optimizeDeps: { entries: ["index.html"] },
  server: {
    host: "127.0.0.1",
    port: 1437,
    strictPort: true,
    open: false,
    fs: { strict: true, allow: allowed },
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:1437; img-src 'self' data:; object-src 'none'",
    },
  },
});
