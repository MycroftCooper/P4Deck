/**
 * Compatibility facade over src/shared/i18n/.
 *
 * The original flat dictionary is gone; entries now live in the catalogs and
 * are addressed by namespaced keys (`common.refresh`, `files.getLatest`, …).
 * `messages[locale]` is preserved as a lookup shim so existing call sites keep
 * working while they migrate to t()/useT().
 */
import { storage } from "./lib/storage";
import type { Locale } from "./contracts";
import { zh as catalogZh, type MsgKey } from "./i18n/catalog.zh";
import { en as catalogEn } from "./i18n/catalog.en";
import { setLocale } from "./i18n/t";

/** Legacy flat keys that used to live in this module -> their new catalog key. */
const legacyKeys = {
  app: "common.app",
  changes: "nav.changes",
  changelists: "nav.changelists",
  depot: "nav.depot",
  history: "nav.history",
  streams: "nav.streams",
  title: "changes.title",
  search: "changes.search",
  filters: "changes.filters",
  allStatuses: "changes.allStatuses",
  pending: "changes.pending",
  submitted: "changes.submitted",
  shelved: "changes.shelved",
  last30: "changes.last30",
  hideMerges: "changes.hideMerges",
  hidden: "common.hidden",
  changesUnit: "changes.countUnit",
  refresh: "common.refresh",
  files: "changes.columns.files",
  user: "changes.columns.user",
  workspace: "changes.columns.workspace",
  time: "changes.columns.time",
  status: "changes.columns.status",
  merge: "merge.branch",
  suspected: "merge.suspected",
  normalChange: "merge.normal",
  unknownClassification: "merge.unknown",
  classification: "merge.classification",
  inspection: "merge.inspection",
  inspectionComplete: "merge.inspectionComplete",
  inspectionPartial: "merge.inspectionPartial",
  inspectionUnavailable: "merge.inspectionUnavailable",
  detailLoading: "submitted.detailLoading",
  detailError: "submitted.detailError",
  retry: "common.retry",
  jobs: "submitted.jobs",
  noJobs: "submitted.noJobs",
  integrationEvidence: "submitted.integrationEvidence",
  noIntegrationEvidence: "submitted.noIntegrationEvidence",
  submittedFiles: "submitted.files",
  noSubmittedFiles: "submitted.noFiles",
  action: "changes.columns.action",
  fileType: "changes.columns.fileType",
  mockDetailNotice: "mock.detailNotice",
  reliableEvidenceHint: "merge.reliableHint",
  suspectedHint: "merge.suspectedHint",
  unknownHint: "merge.unknownHint",
  empty: "changes.empty",
  terminal: "nav.terminal",
  logs: "nav.logs",
  openTools: "nav.openTools",
  close: "common.close",
  commandPlaceholder: "tools.commandPlaceholder",
  run: "common.run",
  clear: "common.clear",
  cancel: "common.cancel",
  noLogs: "tools.noLogs",
  warning: "common.warning",
  error: "common.error",
  info: "common.info",
  connected: "tools.connected",
  mock: "mock.badge",
  language: "locale.switch",
  move: "common.move",
  shelve: "common.shelve",
  unshelve: "common.unshelve",
  validate: "files.validateSubmit",
  more: "common.more",
  filesPage: "page.files",
  pendingPage: "page.pending",
  submittedPage: "page.submitted",
  streamsPage: "page.streams",
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
  address: "files.address",
  getLatest: "files.getLatest",
  getRevision: "files.getRevision",
  checkout: "common.checkout",
  add: "common.add",
  delete: "common.delete",
  revert: "common.revert",
  diff: "common.diff",
  revGraph: "files.revGraph",
  submit: "common.submit",
  newCl: "files.newCl",
  path: "changes.columns.path",
  revision: "changes.columns.revision",
  changelist: "changes.columns.cl",
  modified: "changes.columns.modified",
  localState: "changes.columns.localState",
  workspaceTree: "files.workspaceTree",
  depotTree: "files.depotTree",
  locateFailed: "files.locateFailed",
  confirmDelete: "files.confirmDelete",
  fileInspector: "files.inspector",
  noSelection: "files.noSelection",
  shelves: "files.shelves",
  openedFiles: "files.openedFiles",
  externalMerge: "files.externalMerge",
  externalMergeDetecting: "files.externalMergeDetecting",
  externalMergeUnavailable: "files.externalMergeUnavailable",
  externalMergeRunning: "files.externalMergeRunning",
  externalMergeCompleted: "files.externalMergeCompleted",
  externalMergeUnchanged: "files.externalMergeUnchanged",
  externalMergeCancelled: "files.externalMergeCancelled",
  externalMergeTimeout: "files.externalMergeTimeout",
  externalMergeFailed: "files.externalMergeFailed",
  externalMergeNotInstalled: "files.externalMergeNotInstalled",
  streamSoon: "streams.soon",
} as const satisfies Record<string, MsgKey>;

export type Messages = { readonly [K in keyof typeof legacyKeys]: string };

function project(locale: Locale): Messages {
  const catalog = locale === "en-US" ? catalogEn : catalogZh;
  const out: Record<string, string> = {};
  for (const [legacy, key] of Object.entries(legacyKeys))
    out[legacy] = catalog[key];
  return out as Messages;
}

export const messages = {
  "zh-CN": project("zh-CN"),
  "en-US": project("en-US"),
} as const;

export function initialLocale(): Locale {
  const saved = storage.getItem("p4deck.locale");
  if (saved === "zh-CN" || saved === "en-US") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/** Keep the module-level resolver aligned with the rendered locale. */
export function activateLocale(locale: Locale) {
  setLocale(locale);
}
