import { tFor, type MsgKey } from "../../../shared/i18n";
import { useState, type ReactNode } from "react";
import { Bookmark, ChevronDown, RotateCcw, Save, Trash2 } from "lucide-react";
import type {
  SavedSubmittedFilter,
  SubmittedFilterDraft,
  SubmittedFilterValidation,
} from "../submittedFilters";

interface Props {
  typeControl?: ReactNode;
  defaultSelected?: boolean;
  tagOptions?: string[];
  zh: boolean;
  mock: boolean;
  streamOptions: string[];
  streamLoading: boolean;
  streamError: string;
  onLoadStreams(): void;
  currentStream?: string;
  draft: SubmittedFilterDraft;
  errors: SubmittedFilterValidation["errors"];
  savedFilters: SavedSubmittedFilter[];
  onDraftChange(value: SubmittedFilterDraft): void;
  onReset(): void;
  onSavedFiltersChange(value: SavedSubmittedFilter[]): void;
}

export function SubmittedFilterPanel(props: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [tagText, setTagText] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [confirmation, setConfirmation] = useState<
    { type: "overwrite" | "delete"; id: string } | undefined
  >();
  // Every entry is a catalog key; resolve with tr() before rendering.
  const text = {
    title: "pending.title",
    mock: "pending.mock",
    keyword: "pending.keyword",
    users: "pending.users",
    depotPath: "pending.depotPath",
    from: "pending.from",
    to: "pending.to",
    reset: "pending.reset",
    saved: "pending.saved",
    none: "pending.none",
    name: "pending.name",
    save: "pending.save",
    remove: "pending.remove",
    confirmOverwrite: "pending.confirmOverwrite",
    confirmDelete: "pending.confirmDelete",
    confirm: "pending.confirm",
    cancel: "pending.cancel",
    required: "pending.required",
  };
  const tr = (key: string) => tFor(props.zh ? "zh-CN" : "en-US", key as MsgKey);

  const update = <K extends keyof SubmittedFilterDraft>(
    key: K,
    value: SubmittedFilterDraft[K],
  ) => props.onDraftChange({ ...props.draft, [key]: value });
  const selected = props.savedFilters.find((item) => item.id === selectedId);

  function persistFilter(existingId?: string) {
    const normalized = name.trim();
    if (!normalized || normalized.length > 80) {
      setNameError(tr(text.required));
      return;
    }
    const id = existingId ?? crypto.randomUUID();
    const entry: SavedSubmittedFilter = {
      id,
      name: normalized,
      updatedAt: new Date().toISOString(),
      filter: { ...props.draft },
    };
    props.onSavedFiltersChange([
      entry,
      ...props.savedFilters.filter((item) => item.id !== id),
    ]);
    props.onDraftChange(entry.filter);
    setSelectedId(id);
    setName(normalized);
    setNameError("");
    setConfirmation(undefined);
  }

  function requestSave() {
    const normalized = name.trim();
    if (!normalized || normalized.length > 80) {
      setNameError(tr(text.required));
      return;
    }
    const existing = props.savedFilters.find(
      (item) =>
        item.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
    );
    if (existing) {
      setConfirmation({ type: "overwrite", id: existing.id });
      return;
    }
    persistFilter();
  }

  function confirmPending() {
    if (!confirmation) return;
    if (confirmation.type === "overwrite") {
      persistFilter(confirmation.id);
      return;
    }
    props.onSavedFiltersChange(
      props.savedFilters.filter((item) => item.id !== confirmation.id),
    );
    if (selectedId === confirmation.id) {
      setSelectedId("");
      setName("");
    }
    setConfirmation(undefined);
  }

  const field = (
    key: "keyword" | "users" | "depotPath",
    label: string,
    placeholder?: string,
  ) => (
    <label className="submitted-filter-field">
      <span>{label}</span>
      <input
        value={props.draft[key]}
        placeholder={placeholder}
        aria-invalid={Boolean(props.errors[key])}
        aria-describedby={
          props.errors[key] ? `submitted-${key}-error` : undefined
        }
        onChange={(event) => update(key, event.target.value)}
      />
      {props.errors[key] ? (
        <small id={`submitted-${key}-error`} role="alert">
          {props.errors[key]}
        </small>
      ) : null}
    </label>
  );

  return (
    <details className="submitted-filters" open>
      <summary>{tr(text.title)}</summary>
      <div className="submitted-filter-body">
        {props.mock ? (
          <p className="submitted-mock-notice" role="note">
            {tr(text.mock)}
          </p>
        ) : null}
        <div className="submitted-filter-grid">
          {props.typeControl}
          {field("keyword", tr(text.keyword))}
          <div className="submitted-filter-field">
            <span>{props.zh ? "标签" : "Tags"}</span>
            <details className="submitted-stream-picker">
              <summary>
                <span>
                  {props.draft.tags?.join(", ") ||
                    (props.zh ? "不限标签" : "All tags")}
                </span>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="submitted-stream-options">
                <input
                  value={tagText}
                  aria-label={
                    props.zh ? "输入标签并回车" : "Enter a tag and press Enter"
                  }
                  placeholder={
                    props.zh ? "输入标签并回车" : "Enter a tag and press Enter"
                  }
                  onChange={(event) => setTagText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Enter" ||
                      event.nativeEvent.isComposing ||
                      event.keyCode === 229
                    )
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    const tag = tagText.trim();
                    if (tag && !(props.draft.tags ?? []).includes(tag))
                      update("tags", [...(props.draft.tags ?? []), tag]);
                    if (tag) setTagText("");
                  }}
                />
                {[
                  ...new Set([
                    ...(props.tagOptions ?? []),
                    ...(props.draft.tags ?? []),
                  ]),
                ].map((tag) => (
                  <label key={tag} title={tag}>
                    <input
                      type="checkbox"
                      checked={props.draft.tags?.includes(tag) ?? false}
                      onChange={(event) =>
                        update(
                          "tags",
                          event.target.checked
                            ? [...(props.draft.tags ?? []), tag]
                            : (props.draft.tags ?? []).filter(
                                (value) => value !== tag,
                              ),
                        )
                      }
                    />
                    {tag}
                  </label>
                ))}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => update("tags", [])}
                >
                  {props.zh ? "清空" : "Clear"}
                </button>
              </div>
            </details>
          </div>
          {field("users", tr(text.users))}
          <div className="submitted-scope-row">
            {field("depotPath", tr(text.depotPath), "//depot/main/...")}
            <div className="submitted-filter-field">
              <span>Stream</span>
              <details
                className="submitted-stream-picker"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector("summary")?.focus();
                  }
                }}
              >
                <summary>
                  <span>
                    {[
                      ...(props.draft.currentStreamOnly
                        ? [props.zh ? "当前 Stream" : "Current stream"]
                        : []),
                      ...props.draft.streams,
                    ].join(", ") || (props.zh ? "不限 Stream" : "All streams")}
                  </span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="submitted-stream-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={props.draft.currentStreamOnly}
                      disabled={
                        !props.currentStream && !props.draft.currentStreamOnly
                      }
                      onChange={(event) =>
                        update("currentStreamOnly", event.target.checked)
                      }
                    />
                    {props.zh ? "当前 Stream" : "Current stream"}:{" "}
                    {props.currentStream ||
                      (props.zh ? "不可用" : "Unavailable")}
                  </label>
                  {[
                    ...new Set([
                      ...props.streamOptions,
                      ...props.draft.streams,
                    ]),
                  ]
                    .sort()
                    .map((stream) => (
                      <label key={stream} title={stream}>
                        <input
                          type="checkbox"
                          checked={props.draft.streams.includes(stream)}
                          onChange={(event) =>
                            update(
                              "streams",
                              event.target.checked
                                ? [...props.draft.streams, stream]
                                : props.draft.streams.filter(
                                    (value) => value !== stream,
                                  ),
                            )
                          }
                        />
                        {stream}
                      </label>
                    ))}
                  {props.streamLoading && (
                    <small role="status">
                      {props.zh ? "正在读取…" : "Loading…"}
                    </small>
                  )}
                  {props.streamError && (
                    <small role="alert">{props.streamError}</small>
                  )}
                  {!props.streamLoading && !props.streamOptions.length && (
                    <small>
                      {props.zh
                        ? "暂无缓存的 Stream 选项"
                        : "No cached stream options"}
                    </small>
                  )}
                  <div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={props.streamLoading}
                      onClick={props.onLoadStreams}
                    >
                      {props.zh ? "读取列表" : "Load list"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        props.onDraftChange({
                          ...props.draft,
                          streams: [],
                          currentStreamOnly: false,
                        })
                      }
                    >
                      {props.zh ? "清空" : "Clear"}
                    </button>
                  </div>
                </div>
              </details>
              {(props.errors.streams || props.errors.currentStreamOnly) && (
                <small role="alert">
                  {props.errors.streams || props.errors.currentStreamOnly}
                </small>
              )}
            </div>
          </div>
          <div className="submitted-date-range">
            <label className="submitted-filter-field">
              <span>{tr(text.from)}</span>
              <input
                type="datetime-local"
                value={props.draft.from}
                aria-invalid={Boolean(props.errors.from)}
                aria-describedby={
                  props.errors.from ? "submitted-from-error" : undefined
                }
                onChange={(event) => update("from", event.target.value)}
              />
              {props.errors.from ? (
                <small id="submitted-from-error" role="alert">
                  {props.errors.from}
                </small>
              ) : null}
            </label>
            <label className="submitted-filter-field">
              <span>{tr(text.to)}</span>
              <input
                type="datetime-local"
                value={props.draft.to}
                aria-invalid={Boolean(props.errors.to)}
                aria-describedby={
                  props.errors.to ? "submitted-to-error" : undefined
                }
                onChange={(event) => update("to", event.target.value)}
              />
              {props.errors.to ? (
                <small id="submitted-to-error" role="alert">
                  {props.errors.to}
                </small>
              ) : null}
            </label>
          </div>
        </div>
        <div className="submitted-saved-filters" aria-label={tr(text.saved)}>
          <div className="submitted-preset-group">
            <Bookmark size={16} aria-hidden="true" />
            <select
              aria-label={tr(text.saved)}
              value={
                props.defaultSelected
                  ? "builtin:mine"
                  : selectedId
                    ? `saved:${selectedId}`
                    : ""
              }
              onChange={(event) => {
                if (event.target.value === "builtin:mine") {
                  setSelectedId("");
                  setName("");
                  setConfirmation(undefined);
                  props.onReset();
                  return;
                }
                const id = event.target.value.replace(/^saved:/, "");
                setSelectedId(id);
                setConfirmation(undefined);
                const item = props.savedFilters.find(
                  (entry) => entry.id === id,
                );
                setName(item?.name ?? "");
                setNameError("");
                if (item && (id !== selectedId || props.defaultSelected)) {
                  props.onDraftChange({ ...item.filter });
                }
              }}
            >
              <option value="">{tr(text.none)}</option>
              <option value="builtin:mine">
                {props.zh ? "我的提交（默认）" : "My submissions (default)"}
              </option>
              {props.savedFilters.map((item) => (
                <option key={item.id} value={`saved:${item.id}`}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div className="submitted-preset-group">
            <input
              className="submitted-filter-name"
              value={name}
              maxLength={80}
              placeholder={tr(text.name)}
              aria-label={tr(text.name)}
              aria-invalid={Boolean(nameError)}
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
                setConfirmation(undefined);
              }}
            />
            <button className="secondary" onClick={requestSave}>
              <Save size={14} aria-hidden="true" />
              {tr(text.save)}
            </button>
            <button
              className="secondary"
              disabled={!selected}
              onClick={() =>
                selected && setConfirmation({ type: "delete", id: selected.id })
              }
            >
              <Trash2 size={14} aria-hidden="true" />
              {tr(text.remove)}
            </button>
          </div>
          <button className="secondary" onClick={props.onReset}>
            <RotateCcw size={14} aria-hidden="true" />
            {tr(text.reset)}
          </button>
        </div>
        {selected?.migrated && (
          <p role="note">
            {props.zh
              ? "旧过滤器已迁移：移除旧 Client/Merge/Job 条件，旧当前 Stream 保留为快捷项；已按迁移后的条件应用。"
              : "Migrated filter: legacy Client/Merge/Job conditions removed; the current-stream shortcut is preserved. Applied with the migrated conditions."}
          </p>
        )}
        {nameError ? (
          <p className="submitted-filter-error" role="alert">
            {nameError}
          </p>
        ) : null}
        {confirmation ? (
          <div
            className="submitted-filter-confirmation"
            role="alertdialog"
            aria-label={
              confirmation.type === "overwrite"
                ? tr(text.confirmOverwrite)
                : tr(text.confirmDelete)
            }
            aria-live="assertive"
          >
            <span>
              {confirmation.type === "overwrite"
                ? tr(text.confirmOverwrite)
                : tr(text.confirmDelete)}
            </span>
            <button className="secondary" onClick={confirmPending} autoFocus>
              {tr(text.confirm)}
            </button>
            <button
              className="secondary"
              onClick={() => setConfirmation(undefined)}
            >
              {tr(text.cancel)}
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
