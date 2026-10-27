import { useState, type ReactNode } from "react";
import { Bookmark, ChevronDown, RotateCcw, Save, Trash2 } from "lucide-react";
import type {
  SavedSubmittedFilter,
  SubmittedFilterDraft,
  SubmittedFilterValidation,
} from "../submittedFilters";

interface Props {
  typeControl?: ReactNode;
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
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [confirmation, setConfirmation] = useState<
    { type: "overwrite" | "delete"; id: string } | undefined
  >();
  const text = props.zh
    ? {
        title: "已提交组合筛选",
        mock: "模拟数据 · 查询不会访问真实 P4 Server 或网络",

        keyword: "关键词",
        users: "用户",
        depotPath: "Depot Path",
        from: "起始时间",
        to: "结束时间",
        reset: "重置为默认过滤器",
        saved: "保存的过滤器",
        none: "未选择",
        name: "过滤器名称",
        save: "保存",
        remove: "删除",
        confirmOverwrite: "同名过滤器已存在。确认覆盖？",
        confirmDelete: "确认删除此过滤器？",
        confirm: "确认",
        cancel: "取消",
        required: "请输入 1–80 字符的名称。",
      }
    : {
        title: "Submitted filters",
        mock: "Mock data · this query does not access a real P4 Server or network",

        keyword: "Keyword",
        users: "User",
        depotPath: "Depot Path",
        from: "Start time",
        to: "End time",
        reset: "Reset to default filter",
        saved: "Saved filters",
        none: "None selected",
        name: "Filter name",
        save: "Save",
        remove: "Delete",
        confirmOverwrite: "A filter with this name exists. Overwrite it?",
        confirmDelete: "Delete this saved filter?",
        confirm: "Confirm",
        cancel: "Cancel",
        required: "Enter a name between 1 and 80 characters.",
      };

  const update = <K extends keyof SubmittedFilterDraft>(
    key: K,
    value: SubmittedFilterDraft[K],
  ) => props.onDraftChange({ ...props.draft, [key]: value });
  const selected = props.savedFilters.find((item) => item.id === selectedId);

  function persistFilter(existingId?: string) {
    const normalized = name.trim();
    if (!normalized || normalized.length > 80) {
      setNameError(text.required);
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
    setSelectedId(id);
    setName(normalized);
    setNameError("");
    setConfirmation(undefined);
  }

  function requestSave() {
    const normalized = name.trim();
    if (!normalized || normalized.length > 80) {
      setNameError(text.required);
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
      <summary>{text.title}</summary>
      <div className="submitted-filter-body">
        {props.mock ? (
          <p className="submitted-mock-notice" role="note">
            {text.mock}
          </p>
        ) : null}
        <div className="submitted-filter-grid">
          {props.typeControl}
          {field("keyword", text.keyword)}
          {field("users", text.users)}
          <div className="submitted-scope-row">
            {field("depotPath", text.depotPath, "//depot/main/...")}
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
              <span>{text.from}</span>
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
              <span>{text.to}</span>
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
        <div className="submitted-saved-filters" aria-label={text.saved}>
          <div className="submitted-preset-group">
            <Bookmark size={16} aria-hidden="true" />
            <select
              aria-label={text.saved}
              value={selectedId}
              onChange={(event) => {
                const id = event.target.value;
                setSelectedId(id);
                setConfirmation(undefined);
                const item = props.savedFilters.find(
                  (entry) => entry.id === id,
                );
                setName(item?.name ?? "");
                setNameError("");
                if (item && id !== selectedId) {
                  props.onDraftChange({ ...item.filter });
                }
              }}
            >
              <option value="">{text.none}</option>
              {props.savedFilters.map((item) => (
                <option key={item.id} value={item.id}>
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
              placeholder={text.name}
              aria-label={text.name}
              aria-invalid={Boolean(nameError)}
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
                setConfirmation(undefined);
              }}
            />
            <button className="secondary" onClick={requestSave}>
              <Save size={14} aria-hidden="true" />
              {text.save}
            </button>
            <button
              className="secondary"
              disabled={!selected}
              onClick={() =>
                selected && setConfirmation({ type: "delete", id: selected.id })
              }
            >
              <Trash2 size={14} aria-hidden="true" />
              {text.remove}
            </button>
          </div>
          <button className="secondary" onClick={props.onReset}>
            <RotateCcw size={14} aria-hidden="true" />
            {text.reset}
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
                ? text.confirmOverwrite
                : text.confirmDelete
            }
            aria-live="assertive"
          >
            <span>
              {confirmation.type === "overwrite"
                ? text.confirmOverwrite
                : text.confirmDelete}
            </span>
            <button className="secondary" onClick={confirmPending} autoFocus>
              {text.confirm}
            </button>
            <button
              className="secondary"
              onClick={() => setConfirmation(undefined)}
            >
              {text.cancel}
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
