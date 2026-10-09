use crate::domain::ManualMergeFileSnapshot;
use sha2::{Digest, Sha256};
use similar::{DiffOp, TextDiff};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use uuid::Uuid;

pub const MAX_MANUAL_MERGE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_MANUAL_MERGE_LINES: usize = 100_000;

#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)]
pub(crate) fn writable_permissions(permissions: &std::fs::Permissions) -> std::fs::Permissions {
    let mut writable = permissions.clone();
    writable.set_readonly(false);
    writable
}

#[cfg(unix)]
pub(crate) fn writable_permissions(permissions: &std::fs::Permissions) -> std::fs::Permissions {
    use std::os::unix::fs::PermissionsExt;

    std::fs::Permissions::from_mode(permissions.mode() | 0o200)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextDocument {
    pub text: String,
    pub encoding: String,
    pub had_bom: bool,
    pub line_ending: String,
}

pub struct AtomicReplaceResult {
    pub backup_path: PathBuf,
    pub durability_confirmed: bool,
}

#[derive(Clone, Debug)]
struct Hunk {
    start: usize,
    end: usize,
    replacement: Vec<String>,
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn ensure_regular_file(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Workspace file metadata cannot be read: {error}"))?;
    #[cfg(windows)]
    let is_reparse_point = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    };
    #[cfg(not(windows))]
    let is_reparse_point = false;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point {
        return Err(
            "Manual merge requires a regular file; links and reparse points are blocked".into(),
        );
    }
    Ok(metadata)
}

pub fn secure_workspace_file(root: &str, candidate: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("Workspace root cannot be resolved: {error}"))?;
    ensure_regular_file(Path::new(candidate))?;
    let path = std::fs::canonicalize(candidate)
        .map_err(|error| format!("Workspace file cannot be resolved: {error}"))?;
    if !path.starts_with(&root) {
        return Err("The merge target is outside the active workspace root".into());
    }
    ensure_regular_file(&path)?;
    Ok(path)
}

pub fn snapshot(path: &Path) -> Result<(ManualMergeFileSnapshot, Vec<u8>), String> {
    let metadata = ensure_regular_file(path)?;
    if metadata.len() > MAX_MANUAL_MERGE_BYTES {
        return Err(format!(
            "Manual merge is limited to {} bytes",
            MAX_MANUAL_MERGE_BYTES
        ));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| format!("Workspace file cannot be opened: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_MANUAL_MERGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Workspace file cannot be read: {error}"))?;
    if bytes.len() as u64 > MAX_MANUAL_MERGE_BYTES {
        return Err(format!(
            "Manual merge is limited to {} bytes",
            MAX_MANUAL_MERGE_BYTES
        ));
    }
    let final_metadata = file
        .metadata()
        .map_err(|error| format!("Workspace file metadata cannot be rechecked: {error}"))?;
    if final_metadata.len() != bytes.len() as u64
        || final_metadata.len() != metadata.len()
        || final_metadata.modified().ok() != metadata.modified().ok()
    {
        return Err("Workspace file changed while its merge snapshot was being read".into());
    }
    let modified_ms = final_metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default();
    Ok((
        ManualMergeFileSnapshot {
            size: final_metadata.len(),
            modified_ms,
            content_digest: sha256(&bytes),
        },
        bytes,
    ))
}

pub fn decode(bytes: &[u8]) -> Result<TextDocument, String> {
    let (text, encoding, had_bom) = if let Some(body) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        (
            String::from_utf8(body.to_vec()).map_err(|_| "Invalid UTF-8 after BOM")?,
            "UTF-8".to_owned(),
            true,
        )
    } else if let Some(body) = bytes.strip_prefix(&[0xff, 0xfe]) {
        if body.len() % 2 != 0 {
            return Err("Invalid UTF-16LE byte length".into());
        }
        let units = body
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        (
            String::from_utf16(&units).map_err(|_| "Invalid UTF-16LE text")?,
            "UTF-16LE".to_owned(),
            true,
        )
    } else if let Some(body) = bytes.strip_prefix(&[0xfe, 0xff]) {
        if body.len() % 2 != 0 {
            return Err("Invalid UTF-16BE byte length".into());
        }
        let units = body
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        (
            String::from_utf16(&units).map_err(|_| "Invalid UTF-16BE text")?,
            "UTF-16BE".to_owned(),
            true,
        )
    } else {
        (
            String::from_utf8(bytes.to_vec())
                .map_err(|_| "Text encoding is not safely identifiable as UTF-8 or BOM UTF-16")?,
            "UTF-8".to_owned(),
            false,
        )
    };
    if text.lines().count() > MAX_MANUAL_MERGE_LINES {
        return Err(format!(
            "Manual merge is limited to {MAX_MANUAL_MERGE_LINES} lines"
        ));
    }
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    let line_ending = if lf == 0 {
        "none"
    } else if crlf == lf {
        "CRLF"
    } else if crlf == 0 {
        "LF"
    } else {
        "mixed"
    };
    Ok(TextDocument {
        text,
        encoding,
        had_bom,
        line_ending: line_ending.into(),
    })
}

pub fn encode(text: &str, encoding: &str, had_bom: bool) -> Result<Vec<u8>, String> {
    match encoding {
        "UTF-8" => {
            let mut bytes = Vec::with_capacity(text.len() + usize::from(had_bom) * 3);
            if had_bom {
                bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            }
            bytes.extend_from_slice(text.as_bytes());
            Ok(bytes)
        }
        "UTF-16LE" | "UTF-16BE" => {
            let little = encoding == "UTF-16LE";
            let mut bytes = Vec::with_capacity(text.len() * 2 + 2);
            if had_bom {
                bytes.extend_from_slice(if little { &[0xff, 0xfe] } else { &[0xfe, 0xff] });
            }
            for unit in text.encode_utf16() {
                let encoded = if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                };
                bytes.extend_from_slice(&encoded);
            }
            Ok(bytes)
        }
        _ => Err("Unsupported manual merge encoding".into()),
    }
}

fn normalized_lines(value: &str) -> Vec<String> {
    value
        .replace("\r\n", "\n")
        .split_inclusive('\n')
        .map(str::to_owned)
        .collect()
}

fn hunks(base: &[String], side: &[String]) -> Vec<Hunk> {
    let old = base.iter().map(String::as_str).collect::<Vec<_>>();
    let new = side.iter().map(String::as_str).collect::<Vec<_>>();
    TextDiff::from_slices(&old, &new)
        .ops()
        .iter()
        .filter_map(|operation| match operation {
            DiffOp::Equal { .. } => None,
            _ => {
                let old_range = operation.old_range();
                let new_range = operation.new_range();
                Some(Hunk {
                    start: old_range.start,
                    end: old_range.end,
                    replacement: side[new_range].to_vec(),
                })
            }
        })
        .collect()
}

fn variant(base: &[String], start: usize, end: usize, changes: &[Hunk]) -> Vec<String> {
    let mut output = Vec::new();
    let mut cursor = start;
    for change in changes {
        output.extend_from_slice(&base[cursor..change.start]);
        output.extend(change.replacement.clone());
        cursor = change.end;
    }
    output.extend_from_slice(&base[cursor..end]);
    output
}

pub fn merge_text(base: &str, yours: &str, theirs: &str, line_ending: &str) -> (String, usize) {
    if yours == theirs {
        return (yours.to_owned(), 0);
    }
    if yours == base {
        return (theirs.to_owned(), 0);
    }
    if theirs == base {
        return (yours.to_owned(), 0);
    }
    let base = normalized_lines(base);
    let yours_lines = normalized_lines(yours);
    let theirs_lines = normalized_lines(theirs);
    let yours_hunks = hunks(&base, &yours_lines);
    let theirs_hunks = hunks(&base, &theirs_lines);
    let mut yi = 0;
    let mut ti = 0;
    let mut cursor = 0;
    let mut output = Vec::new();
    let mut conflicts = 0;
    while yi < yours_hunks.len() || ti < theirs_hunks.len() {
        let next = yours_hunks
            .get(yi)
            .map(|h| h.start)
            .into_iter()
            .chain(theirs_hunks.get(ti).map(|h| h.start))
            .min()
            .unwrap();
        output.extend_from_slice(&base[cursor..next]);
        let start = next;
        let mut end = start;
        let y0 = yi;
        let t0 = ti;
        loop {
            let mut advanced = false;
            while let Some(change) = yours_hunks.get(yi) {
                if change.start > end {
                    break;
                }
                end = end.max(change.end);
                yi += 1;
                advanced = true;
            }
            while let Some(change) = theirs_hunks.get(ti) {
                if change.start > end {
                    break;
                }
                end = end.max(change.end);
                ti += 1;
                advanced = true;
            }
            if !advanced
                || (yours_hunks.get(yi).is_none_or(|h| h.start > end)
                    && theirs_hunks.get(ti).is_none_or(|h| h.start > end))
            {
                break;
            }
        }
        let base_variant = base[start..end].to_vec();
        let yours_variant = variant(&base, start, end, &yours_hunks[y0..yi]);
        let theirs_variant = variant(&base, start, end, &theirs_hunks[t0..ti]);
        if yours_variant == theirs_variant {
            output.extend(yours_variant);
        } else if yours_variant == base_variant {
            output.extend(theirs_variant);
        } else if theirs_variant == base_variant {
            output.extend(yours_variant);
        } else {
            conflicts += 1;
            output.push(format!("<<<<<<< P4DECK YOURS:{conflicts}\n"));
            output.extend(yours_variant);
            output.push("======= P4DECK\n".into());
            output.extend(theirs_variant);
            output.push(format!(">>>>>>> P4DECK THEIRS:{conflicts}\n"));
        }
        cursor = end;
    }
    output.extend_from_slice(&base[cursor..]);
    let mut merged = output.concat();
    if line_ending == "CRLF" {
        merged = merged.replace('\n', "\r\n");
    }
    (merged, conflicts)
}

pub fn unresolved_blocks(text: &str) -> usize {
    text.match_indices("<<<<<<< P4DECK YOURS:").count()
}

pub fn has_conflict_marker(text: &str) -> bool {
    ["<<<<<<< P4DECK", "======= P4DECK", ">>>>>>> P4DECK"]
        .iter()
        .any(|marker| text.contains(marker))
}

pub fn atomic_replace_with_backup(
    path: &Path,
    bytes: &[u8],
) -> Result<AtomicReplaceResult, String> {
    atomic_replace_with_backup_impl(path, bytes, false)
}

fn atomic_replace_with_backup_impl(
    path: &Path,
    bytes: &[u8],
    fail_before_replace: bool,
) -> Result<AtomicReplaceResult, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("Merge target cannot be revalidated: {error}"))?;
    let target_metadata = ensure_regular_file(path)
        .map_err(|error| format!("Merge target cannot be revalidated: {error}"))?;
    let parent = path
        .parent()
        .ok_or("Merge target has no parent directory")?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|error| format!("Merge target directory cannot be revalidated: {error}"))?;
    if canonical.parent() != Some(canonical_parent.as_path()) {
        return Err("Merge target changed through a symlink or junction before save".into());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let nonce = Uuid::new_v4();
    let temp = parent.join(format!(".{name}.p4deck-merge-{nonce}.tmp"));
    let backup = parent.join(format!(".{name}.p4deck-merge-backup-{nonce}"));
    let original_permissions = target_metadata.permissions();
    let prepare_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::set_permissions(&temp, original_permissions.clone())?;
        if fail_before_replace {
            return Err(std::io::Error::other("injected atomic replace failure"));
        }
        #[cfg(windows)]
        {
            std::fs::set_permissions(path, writable_permissions(&original_permissions))?;
        }
        Ok::<(), std::io::Error>(())
    })();
    if let Err(error) = prepare_result {
        let _ = std::fs::set_permissions(path, original_permissions.clone());
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Atomic merge save failed; the original file was preserved: {error}"
        ));
    }
    if let Err(error) = atomic_replace(path, &temp, &backup) {
        let _ = std::fs::set_permissions(path, original_permissions);
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Atomic merge save failed; the original file was preserved: {error}"
        ));
    }
    Ok(AtomicReplaceResult {
        backup_path: backup,
        durability_confirmed: sync_parent(parent).is_ok(),
    })
}

#[cfg(windows)]
fn atomic_replace(path: &Path, temp: &Path, backup: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    if std::fs::hard_link(path, backup).is_err() {
        std::fs::copy(path, backup)?;
        std::fs::File::open(backup)?.sync_all()?;
    }
    let path = wide(path);
    let temp = wide(temp);
    let result = unsafe {
        MoveFileExW(
            temp.as_ptr(),
            path.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(path: &Path, temp: &Path, backup: &Path) -> std::io::Result<()> {
    std::fs::hard_link(path, backup)?;
    std::fs::rename(temp, path)
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> std::io::Result<()> {
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_no_single_and_multiple_conflicts_without_matching_duplicate_text() {
        assert_eq!(merge_text("a\n", "a\n", "b\n", "LF"), ("b\n".into(), 0));
        let (single, count) = merge_text("a\nb\nc\n", "a\ny\nc\n", "a\nt\nc\n", "LF");
        assert_eq!(count, 1);
        assert_eq!(unresolved_blocks(&single), 1);
        let (multiple, count) = merge_text(
            "same\na\nsame\nb\n",
            "same\ny\nsame\nz\n",
            "same\nt\nsame\nu\n",
            "LF",
        );
        assert_eq!(count, 2);
        assert_eq!(unresolved_blocks(&multiple), 2);
    }

    #[test]
    fn decodes_bom_unicode_and_rejects_invalid_data() {
        assert_eq!(
            decode(b"\xef\xbb\xbfhello\r\n").unwrap().line_ending,
            "CRLF"
        );
        assert_eq!(decode(b"a\r\nb\n").unwrap().line_ending, "mixed");
        let utf16 = encode("雪\n", "UTF-16LE", true).unwrap();
        assert_eq!(decode(&utf16).unwrap().text, "雪\n");
        assert!(decode(&[0xff, 0x00, 0xff]).is_err());
        assert!(decode("x\n".repeat(MAX_MANUAL_MERGE_LINES + 1).as_bytes()).is_err());
    }

    #[test]
    fn atomic_replace_keeps_a_recoverable_backup() {
        let root = std::env::temp_dir().join(format!("p4deck-merge-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("file.txt");
        std::fs::write(&path, b"old").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();
        let backup = atomic_replace_with_backup(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read(&backup.backup_path).unwrap(), b"old");
        assert!(backup.durability_confirmed);
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        std::fs::set_permissions(&path, writable_permissions(&permissions)).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_failure_preserves_original_and_cleans_temporary_file() {
        let root = std::env::temp_dir().join(format!("p4deck-merge-fail-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("file.txt");
        std::fs::write(&path, b"old").unwrap();
        assert!(atomic_replace_with_backup_impl(&path, b"new", true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn secure_path_rejects_workspace_escape_and_oversize() {
        let root = std::env::temp_dir().join(format!("p4deck-merge-root-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("p4deck-merge-outside-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, b"outside").unwrap();
        assert!(secure_workspace_file(root.to_str().unwrap(), outside.to_str().unwrap()).is_err());
        let large = root.join("large.txt");
        let file = std::fs::File::create(&large).unwrap();
        file.set_len(MAX_MANUAL_MERGE_BYTES + 1).unwrap();
        assert!(snapshot(&large).is_err());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_file(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn secure_path_rejects_symlink() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("p4deck-merge-link-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        std::fs::write(&target, b"text").unwrap();
        symlink(&target, &link).unwrap();
        assert!(secure_workspace_file(root.to_str().unwrap(), link.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
