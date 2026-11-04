import { t } from "../../shared/i18n";
import { useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCode2, LoaderCircle } from "lucide-react";
import { useMenuEnvironment } from "../context-menu/environment";
import { backend } from "../../infrastructure/backend";
import { appCache } from "../../shared/cache/appCache";
import { SelectionContext } from "../../features/files/SelectionContext";
import {
  completeFileAddress,
  pathKey,
  workspaceRelativePath,
} from "../../features/files/address";

/** The displayed relative path is separate from the panel's canonical target. */
export function DiffPathInput({
  label,
  target,
  locked,
  zh: _zh,
  onChange,
  raw = false,
  children,
}: {
  label: string;
  target: string;
  locked: boolean;
  zh: boolean;
  onChange(path: string): void;
  raw?: boolean;
  children?: ReactNode;
}) {
  const { runtime, connectionKey } = useMenuEnvironment();
  const context = runtime.context;
  const selected = useContext(SelectionContext).nodes.find(
    (node) => node.depotPath === target && node.absolutePath,
  );
  const knownRelative = selected
    ? workspaceRelativePath(selected.absolutePath, context)
    : undefined;
  const relative = raw
    ? target
    : (knownRelative ?? workspaceRelativePath(target, context));
  const mapping = useQuery(
    {
      // Share mapping reads with the shell; typing never changes this key.
      queryKey: ["resolved-address", connectionKey, target],
      queryFn: () => backend.resolvePath({ input: target }),
      staleTime: 60_000,
      enabled:
        !raw &&
        !!target &&
        relative === undefined &&
        target.startsWith("//") &&
        runtime.p4Version !== "loading",
    },
    appCache,
  );
  const mappedPath =
    knownRelative !== undefined
      ? selected?.absolutePath
      : mapping.data?.found
        ? mapping.data.absolutePath
        : undefined;
  const display =
    relative ??
    (mappedPath ? workspaceRelativePath(mappedPath, context) : undefined) ??
    target;
  const owner = `${connectionKey}\0${target}`;
  const [draft, setDraft] = useState<{ owner: string; text: string }>();
  const [failure, setFailure] = useState<{ owner: string; message: string }>();
  const error = failure?.owner === owner ? failure.message : "";

  const open = (raw: string) => {
    if (locked) return;
    try {
      const completed = completeFileAddress(raw, context);
      // Accepting the displayed path preserves the existing depot identity/cache.
      const unchanged =
        raw === display ||
        pathKey(completed) === pathKey(target) ||
        (mappedPath && pathKey(completed) === pathKey(mappedPath));
      setDraft(undefined);
      setFailure(undefined);
      onChange(unchanged ? target : completed);
    } catch (cause) {
      setFailure({
        owner,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const commit = (value: string) => {
    if (!raw) return open(value);
    if (locked || !value.trim()) return;
    setDraft(undefined);
    onChange(value.trim());
  };

  return (
    <div className="diff-path-field">
      <FileCode2 size={15} aria-hidden="true" />
      <input
        className="target-path-input"
        aria-label={label}
        aria-invalid={!!error}
        title={error || target || context.cwd}
        value={draft?.owner === owner ? draft.text : display}
        disabled={locked}
        placeholder={raw ? label : t("docking.workspace.path.paste.a.local")}
        onChange={(event) => {
          setDraft({ owner, text: event.target.value });
          setFailure(undefined);
        }}
        onPaste={(event) => {
          if (raw) return;
          event.preventDefault();
          open(event.clipboardData.getData("text/plain"));
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(undefined);
            setFailure(undefined);
            event.currentTarget.blur();
          } else if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          }
        }}
      />
      {!raw && mapping.isFetching && (
        <LoaderCircle size={13} className="spin" aria-hidden="true" />
      )}
      {children}
      {error && (
        <span className="diff-path-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
