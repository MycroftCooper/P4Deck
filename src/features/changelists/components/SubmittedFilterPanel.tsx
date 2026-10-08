import { useState } from "react";
import { Bookmark, RotateCcw, Save, Trash2 } from "lucide-react";
import type { MergeClassification } from "../../../shared/contracts/types";
import type {
  SavedSubmittedFilter,
  SubmittedFilterDraft,
  SubmittedFilterValidation,
} from "../submittedFilters";

interface Props {
  zh: boolean;
  mock: boolean;
  draft: SubmittedFilterDraft;
  errors: SubmittedFilterValidation["errors"];
  savedFilters: SavedSubmittedFilter[];
  onDraftChange(value: SubmittedFilterDraft): void;
  onReset(): void;
  onSavedFiltersChange(value: SavedSubmittedFilter[]): void;
}

const mergeValues: MergeClassification[] = [
  "normal",
  "reliableMerge",
  "suspectedMerge",
  "unknown",
];

export function SubmittedFilterPanel(props: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [confirmation, setConfirmation] = useState<
    { type: "overwrite" | "delete"; id: string } | undefined
  >();
  const text = props.zh
    ? {
        title: "Submitted 组合筛选",
        mock: "模拟数据 · 查询不会访问真实 P4 Server 或网络",
        semantics: "同一字段内多值为 OR；不同筛选条件之间为 AND。",
        keyword: "关键词",
        users: "User（逗号/换行分隔）",
        clients: "Client（逗号/换行分隔）",
        depotPath: "Depot Path",
        stream: "Stream",
        from: "起始时间",
        to: "结束时间",
        jobs: "Job（逗号/换行分隔）",
        hasJob: "Job 状态",
        any: "不限",
        yes: "有 Job",
        no: "无 Job",
        classification: "Merge 分类（多选为 OR）",
        normal: "普通",
        reliableMerge: "可靠合并",
        suspectedMerge: "疑似合并",
        unknown: "未知",
        hideReliable: "仅隐藏 reliable merge",
        reset: "重置为默认过滤器",
        saved: "保存的过滤器",
        none: "未选择",
        apply: "应用",
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
        semantics: "Values within a field use OR; separate conditions use AND.",
        keyword: "Keyword",
        users: "User (comma/newline separated)",
        clients: "Client (comma/newline separated)",
        depotPath: "Depot Path",
        stream: "Stream",
        from: "Start time",
        to: "End time",
        jobs: "Job (comma/newline separated)",
        hasJob: "Job state",
        any: "Any",
        yes: "Has job",
        no: "No job",
        classification: "Merge classification (OR)",
        normal: "Normal",
        reliableMerge: "Reliable merge",
        suspectedMerge: "Suspected merge",
        unknown: "Unknown",
        hideReliable: "Hide reliable merges only",
        reset: "Reset to default filter",
        saved: "Saved filters",
        none: "None selected",
        apply: "Apply",
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
    key: "keyword" | "users" | "clients" | "depotPath" | "stream" | "jobs",
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
        <p className="submitted-filter-semantics">{text.semantics}</p>
        <div className="submitted-filter-grid">
          {field("keyword", text.keyword)}
          {field("users", text.users, "alice, buildbot")}
          {field("clients", text.clients, "workspace-a, workspace-b")}
          {field("depotPath", text.depotPath, "//depot/main/...")}
          {field("stream", text.stream, "//depot/main")}
          {field("jobs", text.jobs, "JOB-1, JOB-2")}
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
          <label className="submitted-filter-field">
            <span>{text.hasJob}</span>
            <select
              value={props.draft.hasJob}
              aria-invalid={Boolean(props.errors.hasJob)}
              aria-describedby={
                props.errors.hasJob ? "submitted-has-job-error" : undefined
              }
              onChange={(event) =>
                update(
                  "hasJob",
                  event.target.value as SubmittedFilterDraft["hasJob"],
                )
              }
            >
              <option value="any">{text.any}</option>
              <option value="yes">{text.yes}</option>
              <option value="no">{text.no}</option>
            </select>
            {props.errors.hasJob ? (
              <small id="submitted-has-job-error" role="alert">
                {props.errors.hasJob}
              </small>
            ) : null}
          </label>
        </div>
        <fieldset className="submitted-merge-filters">
          <legend>{text.classification}</legend>
          {mergeValues.map((value) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={props.draft.mergeClassifications.includes(value)}
                onChange={(event) =>
                  update(
                    "mergeClassifications",
                    event.target.checked
                      ? [...props.draft.mergeClassifications, value]
                      : props.draft.mergeClassifications.filter(
                          (item) => item !== value,
                        ),
                  )
                }
              />
              {text[value]}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={props.draft.hideReliableMerges}
              onChange={(event) =>
                update("hideReliableMerges", event.target.checked)
              }
            />
            {text.hideReliable}
          </label>
        </fieldset>
        <div className="submitted-saved-filters" aria-label={text.saved}>
          <Bookmark size={16} aria-hidden="true" />
          <select
            aria-label={text.saved}
            value={selectedId}
            onChange={(event) => {
              const id = event.target.value;
              setSelectedId(id);
              setConfirmation(undefined);
              const item = props.savedFilters.find((entry) => entry.id === id);
              setName(item?.name ?? "");
            }}
          >
            <option value="">{text.none}</option>
            {props.savedFilters.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="secondary"
            disabled={!selected}
            onClick={() =>
              selected && props.onDraftChange({ ...selected.filter })
            }
          >
            {text.apply}
          </button>
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
          <button className="secondary" onClick={props.onReset}>
            <RotateCcw size={14} aria-hidden="true" />
            {text.reset}
          </button>
        </div>
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
