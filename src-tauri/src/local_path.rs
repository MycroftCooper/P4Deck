//! One normalization for paths that leave Rust's own `std::fs` boundary.
//!
//! `std::fs::canonicalize` returns *verbatim* Windows paths (`\\?\E:\...`). Those
//! break every consumer that expects an ordinary path:
//! - p4 rejects them in arguments ("Path ... is not under client's root"),
//! - `SHOpenWithDialog` answers `E_INVALIDARG` (0x80070057),
//! - `explorer` / `CreateProcess` may drop the target,
//! - the UI and the clipboard would show `\\?\...`.
//!
//! Keeping a single implementation here means a new call site cannot quietly
//! re-introduce the leak, and the existing scattered copies cannot drift (one of
//! them already looked for a lowercase `\\?\unc\` prefix that Windows never
//! emits, which left `\\?\UNC\...` untouched).
//!
//! `std::fs` itself accepts verbatim paths, so filesystem-only code should keep
//! the canonical form; normalize exactly at the boundary.

/// Strip a Windows verbatim prefix: `\\?\C:\...` -> `C:\...` and
/// `\\?\UNC\server\share` -> `\\server\share`. Forward-slash spellings
/// (`//?/c:/...`) are normalized the same way. Anything else is returned as-is.
pub(crate) fn plain_local_path(value: &str) -> String {
    let Some(rest) = strip_prefix_ignore_ascii_case(value, r"\\?\")
        .or_else(|| strip_prefix_ignore_ascii_case(value, "//?/"))
    else {
        return value.to_owned();
    };
    if let Some(unc) = strip_prefix_ignore_ascii_case(rest, r"UNC\")
        .or_else(|| strip_prefix_ignore_ascii_case(rest, "unc/"))
        .or_else(|| strip_prefix_ignore_ascii_case(rest, r"unc\"))
        .or_else(|| strip_prefix_ignore_ascii_case(rest, "UNC/"))
    {
        return format!(r"\\{unc}");
    }
    rest.to_owned()
}

/// `plain_local_path` for a [`std::path::Path`].
pub(crate) fn plain_path(path: &std::path::Path) -> String {
    plain_local_path(&path.to_string_lossy())
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn strips_drive_and_unc_verbatim_prefixes() {
        assert_eq!(
            plain_local_path(r"\\?\C:\Work\Main\File.txt"),
            r"C:\Work\Main\File.txt"
        );
        assert_eq!(
            plain_local_path(r"\\?\UNC\server\share\file.txt"),
            r"\\server\share\file.txt"
        );
        // Windows canonicalize emits uppercase UNC; older code looked for
        // lowercase and leaked the prefix. Both cases must normalize.
        assert_eq!(
            plain_local_path(r"\\?\unc\server\share\file.txt"),
            r"\\server\share\file.txt"
        );
    }

    #[test]
    fn normalizes_forward_slash_verbatim_forms() {
        assert_eq!(plain_local_path("//?/C:/Work/File.txt"), "C:/Work/File.txt");
        assert_eq!(
            plain_local_path("//?/UNC/server/share/file.txt"),
            r"\\server/share/file.txt"
        );
    }

    #[test]
    fn leaves_ordinary_paths_untouched() {
        for value in [
            r"C:\Work\Main\File.txt",
            r"\\server\share\file.txt",
            "/home/user/work/file.txt",
            "",
        ] {
            assert_eq!(plain_local_path(value), value);
        }
    }

    #[test]
    fn handles_non_ascii_without_panicking() {
        assert_eq!(
            plain_local_path(r"\\?\E:\项目\资源.png"),
            r"E:\项目\资源.png"
        );
    }

    #[test]
    fn plain_path_delegates() {
        assert_eq!(
            plain_path(Path::new(r"\\?\D:\Workspace\File.txt")),
            r"D:\Workspace\File.txt"
        );
    }
}
