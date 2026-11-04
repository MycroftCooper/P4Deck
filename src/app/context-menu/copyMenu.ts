/**
 * Copy-menu detection without relying on Chinese label text.
 *
 * The copy commands used to be recognised by string-matching their labels
 * (`label.startsWith("复制 › ")`), which breaks the moment the wording or the
 * locale changes. They are recognised here by prefix in either language, and
 * new copy entries only need to extend this table.
 */

/** Leading token of every copy submenu entry, per locale. */
const copyPrefixes = ["复制 › ", "Copy › "];

/** Labels that copy a single scoped path directly. */
export const copyLeafLabels = new Set([
  "复制工作区根路径",
  "复制 Depot 路径",
  "Copy workspace root path",
  "Copy depot path",
]);

export function isCopyMenu(label: string): boolean {
  return copyPrefixes.some((prefix) => label.startsWith(prefix));
}

export function isCopyCommandLabel(label: string): boolean {
  return isCopyMenu(label) || copyLeafLabels.has(label);
}

/** Which path field a copy submenu entry refers to. */
export function copyFieldFor(label: string): "name" | "depotPath" | "relativePath" | "absolutePath" {
  if (/文件名|目录名|名称|file name|folder name|name/i.test(label)) return "name";
  if (/Depot|depot/i.test(label)) return "depotPath";
  if (/相对|relative/i.test(label)) return "relativePath";
  return "absolutePath";
}
