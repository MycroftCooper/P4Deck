import { useEffect, useMemo, useState } from "react";
import { ChangelistFormDialog } from "../../features/changelists/components/ChangelistFormDialog";
import { MoveFilesDialog } from "../../features/changelists/components/MoveFilesDialog";
import { SubmitDialog } from "../../features/changelists/components/SubmitDialog";
import { ShelfDialog } from "../../features/changelists/components/ShelfDialog";
import { UnshelveDialog } from "../../features/changelists/components/UnshelveDialog";
import { RevisionDialog } from "../../features/files/components/RevisionDialog";
import { RenameDialog } from "../../features/files/components/RenameDialog";
import { ResolveDialog } from "../../features/files/components/ResolveDialog";
import { ManualMergeEditor } from "../../features/files/components/ManualMergeEditor";
import { OperationConfirmDialog } from "./OperationConfirmDialog";
import type { WorkspaceNode } from "../../shared/contracts";

/** Development-only synthetic fixtures. No write adapters or backend calls. */
export default function WorkflowAuditPage() {
  const [zh, setZh] = useState(true),
    [dark, setDark] = useState(false),
    [large, setLarge] = useState(false);
  const [open, setOpen] = useState<{ kind: string; source: HTMLElement }>();
  const kinds = [
    "create",
    "edit",
    "move",
    "submit",
    "revision",
    "rename",
    "batch",
    "shelf",
    "unshelve",
    "resolve",
    "manual-merge",
  ];
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const nodes = useMemo<WorkspaceNode[]>(
    () =>
      Array.from({ length: large ? 50000 : 3 }, (_, index) => ({
        id: String(index),
        name: `file_${String(index).padStart(5, "0")}.txt`,
        absolutePath: `/fixture/file_${String(index).padStart(5, "0")}.txt`,
        relativePath: `file_${index}.txt`,
        depotPath: `//fixture/main/file_${String(index).padStart(5, "0")}.txt`,
        state: "openedEdit",
        kind: "file",
      })),
    [large],
  );
  const paths = nodes.map((node) => node.depotPath!);
  const changes = [
    {
      id: 10,
      description: "UI audit fixture — not server data",
      user: "fixture",
      client: "UI fixture",
      status: "pending" as const,
      jobs: [],
      files: nodes.map((node) => ({
        depotPath: node.depotPath!,
        action: "edit",
        state: node.state,
      })),
      shelvedFiles: [],
    },
    {
      id: 20,
      description: "Target fixture",
      user: "fixture",
      client: "UI fixture",
      status: "pending" as const,
      jobs: [],
      files: [],
      shelvedFiles: [],
    },
  ];
  const dismiss = () => setOpen(undefined);
  const shelf = {
    changeId: 10,
    paths,
    mode: "shelve" as const,
    hasShelf: true,
    source: open?.source ?? null,
  };
  let dialog = null;
  if (open) {
    const common = { zh, source: open.source, onDismiss: dismiss };
    switch (open.kind) {
      case "create":
      case "edit":
        dialog = (
          <ChangelistFormDialog
            {...common}
            mode={open.kind}
            changeId={10}
            client="UI fixture"
            initial={
              open.kind === "edit"
                ? { description: "Fixture description", jobs: [] }
                : undefined
            }
          />
        );
        break;
      case "move":
        dialog = (
          <MoveFilesDialog
            request={{ from: 10, paths, source: open.source }}
            changes={changes}
            client="UI fixture"
            connectionKey="audit"
            zh={zh}
            onDismiss={dismiss}
          />
        );
        break;
      case "submit":
        dialog = (
          <SubmitDialog
            {...common}
            changeId={10}
            count={paths.length}
            client="UI fixture"
            connectionKey="fixture"
            loadSummary={async () => changes[0]}
          />
        );
        break;
      case "revision":
        dialog = (
          <RevisionDialog
            request={{ nodes, source: open.source }}
            zh={zh}
            onClose={dismiss}
          />
        );
        break;
      case "rename":
        dialog = <RenameDialog {...common} node={nodes[0]} />;
        break;
      case "batch":
        dialog = (
          <OperationConfirmDialog
            request={{ operation: "revert", nodes, source: open.source }}
            zh={zh}
            onClose={dismiss}
          />
        );
        break;
      case "shelf":
        dialog = (
          <ShelfDialog
            request={shelf}
            connectionKey="audit"
            zh={zh}
            onDismiss={dismiss}
            check={async () => {
              throw new Error("Synthetic audit: no backend request");
            }}
          />
        );
        break;
      case "unshelve":
        dialog = (
          <UnshelveDialog
            request={shelf}
            changes={changes}
            currentWorkspace="UI fixture"
            connectionKey="audit"
            zh={zh}
            onDismiss={dismiss}
            loadWorkspaces={async () => []}
            check={async () => {
              throw new Error("Synthetic audit: no backend request");
            }}
          />
        );
        break;
      case "resolve":
        dialog = (
          <ResolveDialog
            {...common}
            nodes={nodes}
            connectionKey="audit"
            check={async () => {
              throw new Error("Synthetic audit: no backend request");
            }}
          />
        );
        break;
      case "manual-merge":
        dialog = (
          <section
            className="workflow-dialog-body"
            aria-label="Manual merge fixture"
          >
            <ManualMergeEditor
              depotPath="//fixture/main/file.txt"
              connectionKey="audit"
              zh={zh}
              openSession={async () => ({
                sessionId: "audit-session",
                target: {
                  kind: "resolve",
                  server: "fixture:1666",
                  user: "fixture",
                  client: "fixture",
                  workspace: "/fixture",
                  contextGeneration: 1,
                  depotPaths: ["//fixture/main/file.txt"],
                },
                depotPath: "//fixture/main/file.txt",
                localPath: "/fixture/file.txt",
                baseSource: {
                  depotPath: "//fixture/main/file.txt",
                  revision: 1,
                },
                theirsSource: {
                  depotPath: "//fixture/main/file.txt",
                  revision: 2,
                },
                fileSnapshot: {
                  size: 32,
                  modifiedMs: 1,
                  contentDigest: "audit",
                },
                resolveDigest: "audit",
                base: "base\n",
                theirs: "theirs\n",
                yours: "yours\n",
                result:
                  "<<<<<<< P4DECK YOURS:1\nyours\n======= P4DECK\ntheirs\n>>>>>>> P4DECK THEIRS:1\n",
                encoding: "UTF-8",
                lineEnding: "LF",
                hadBom: false,
                unresolvedBlocks: 1,
                expiresAt: Date.now() + 60_000,
                operationIds: [],
              })}
              cancelOperation={async () => undefined}
            />
          </section>
        );
        break;
    }
  }
  return (
    <main style={{ padding: 20, overflow: "auto", height: "100%" }}>
      <h1>Workflow UI audit — synthetic data only</h1>
      <p>
        Development fixture. No server requests or file writes. 50,000 targets
        are available for virtual-list checks.
      </p>
      <label>
        <input
          type="checkbox"
          checked={zh}
          onChange={(event) => setZh(event.target.checked)}
        />
        Chinese
      </label>
      <label>
        <input
          type="checkbox"
          checked={dark}
          onChange={(event) => setDark(event.target.checked)}
        />
        Dark
      </label>
      <label>
        <input
          type="checkbox"
          checked={large}
          onChange={(event) => setLarge(event.target.checked)}
        />
        50,000 targets
      </label>
      <p>{nodes.length} synthetic targets</p>
      {kinds.map((kind) => (
        <button
          key={kind}
          onClick={(event) => setOpen({ kind, source: event.currentTarget })}
        >
          {kind}
        </button>
      ))}
      {dialog}
    </main>
  );
}
