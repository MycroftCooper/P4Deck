//! External P4Merge adapter for the manual merge flow.
//!
//! P4Merge only produces a candidate result. The user still reviews it in the
//! editor and goes through the existing validation/save/resolve chain, so this
//! module never writes workspace files, never resolves Perforce records, and
//! never logs or persists merge text (the temporary files are deleted best-effort).
//!
//! Detection only inspects the filesystem (`Path::is_file`); it never starts the
//! GUI. Order is the same on every platform: the explicit `P4MERGE` override →
//! common install location(s) → `PATH`. On Windows a `.bat`/`.cmd` override is
//! skipped with a reason because this adapter never uses a shell; point
//! `P4MERGE` at `p4merge.exe` instead. Automated tests exercise the pure helpers
//! below and never launch P4Merge.

use crate::app::manual_merge::{MAX_MANUAL_MERGE_BYTES, MAX_MANUAL_MERGE_LINES};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use uuid::Uuid;

/// P4Merge waits for a human; cap a forgotten window so it cannot pin the app.
pub const EXTERNAL_MERGE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// `Child::try_wait` poll interval; responsive without busy spinning.
pub const EXTERNAL_MERGE_POLL: Duration = Duration::from_millis(200);

/// Fixed staging names. P4Merge receives them in this exact order:
/// `base theirs yours result` (P4Merge's documented four-argument merge mode,
/// also spelled `$BASE $REMOTE $LOCAL $MERGED` by Git's mergetool entry).
pub const INPUT_NAMES: [&str; 4] = ["base.txt", "theirs.txt", "yours.txt", "result.txt"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolSource {
    Env,
    CommonPath,
    Path,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolCandidate {
    pub executable: PathBuf,
    pub source: ToolSource,
}

/// Ordered detection candidates, identical on every platform:
/// `P4MERGE` override → common install locations → `PATH`.
pub fn ordered_candidates(
    env: Option<&Path>,
    common: &[PathBuf],
    path_dirs: &[PathBuf],
    program: &str,
) -> Vec<(PathBuf, ToolSource)> {
    let mut entries = Vec::with_capacity(common.len() + path_dirs.len() + 1);
    entries.extend(env.map(|path| (path.to_path_buf(), ToolSource::Env)));
    entries.extend(
        common
            .iter()
            .map(|path| (path.clone(), ToolSource::CommonPath)),
    );
    entries.extend(
        path_dirs
            .iter()
            .map(|dir| (dir.join(program), ToolSource::Path)),
    );
    entries
}

/// First candidate that is an existing regular file. Directories never match.
pub fn first_existing(candidates: &[(PathBuf, ToolSource)]) -> Option<ToolCandidate> {
    candidates
        .iter()
        .find(|(path, _)| path.is_file())
        .map(|(executable, source)| ToolCandidate {
            executable: executable.clone(),
            source: *source,
        })
}

/// Windows cannot launch a `.bat`/`.cmd` wrapper from `Command::new` without a
/// shell, and this adapter deliberately never uses one. Point P4MERGE at
/// `p4merge.exe` instead; detection falls back to the common paths/PATH.
pub const WINDOWS_WRAPPER_REASON: &str =
    "P4MERGE points to a non-.exe wrapper (for example .bat/.cmd); P4Deck launches p4merge.exe directly without a shell. Set P4MERGE to p4merge.exe.";

/// Normalize the explicit `P4MERGE` override before it enters candidate order:
/// strip shell-style surrounding quotes/whitespace, and on Windows reject
/// batch wrappers so the common install paths/PATH can still win. The returned
/// reason explains a refused override; it is never a launch attempt.
pub fn prepare_env_candidate(
    raw: Option<PathBuf>,
    windows: bool,
) -> (Option<PathBuf>, Option<String>) {
    let Some(raw) = raw else {
        return (None, None);
    };
    let candidate = match raw.to_str() {
        Some(text) => {
            let trimmed = text.trim().trim_matches('"').trim();
            if trimmed.is_empty() {
                return (None, None);
            }
            PathBuf::from(trimmed)
        }
        None => raw,
    };
    if windows && !has_exe_extension(&candidate) {
        return (None, Some(WINDOWS_WRAPPER_REASON.to_owned()));
    }
    (Some(candidate), None)
}

fn has_exe_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[cfg(windows)]
fn common_install_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(key) {
            if !root.is_empty() {
                paths.push(PathBuf::from(root).join("Perforce").join("p4merge.exe"));
            }
        }
    }
    paths.push(PathBuf::from(r"C:\Perforce\p4merge.exe"));
    paths
}

#[cfg(target_os = "macos")]
fn common_install_paths() -> Vec<PathBuf> {
    vec![PathBuf::from(
        "/Applications/p4merge.app/Contents/Resources/launchp4merge",
    )]
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn common_install_paths() -> Vec<PathBuf> {
    Vec::new()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolDetection {
    pub tool: Option<ToolCandidate>,
    /// Explains a refused `P4MERGE` override (Windows batch wrapper) or total miss.
    pub reason: Option<String>,
}

/// Detect an installed P4Merge without launching it.
pub fn detect_tool() -> ToolDetection {
    let raw_env = std::env::var_os("P4MERGE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty());
    let (env, mut reason) = prepare_env_candidate(raw_env, cfg!(windows));
    let common = common_install_paths();
    let path_dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let program = if cfg!(windows) {
        "p4merge.exe"
    } else {
        "p4merge"
    };
    let tool = first_existing(&ordered_candidates(
        env.as_deref(),
        &common,
        &path_dirs,
        program,
    ));
    if tool.is_none() && reason.is_none() {
        reason = Some(
            "P4Merge was not found in P4MERGE, the common install locations, or PATH".to_owned(),
        );
    }
    ToolDetection { tool, reason }
}

#[derive(Clone, Copy, Debug)]
pub struct MergeInputs<'a> {
    pub base: &'a str,
    pub theirs: &'a str,
    pub yours: &'a str,
    pub result: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    Completed {
        result: String,
        exit_code: Option<i32>,
    },
    Unchanged {
        exit_code: Option<i32>,
    },
    Failed {
        exit_code: Option<i32>,
        reason: String,
    },
    Timeout,
    /// Terminated without an exit code, so no saved result can be trusted.
    Cancelled,
}

pub fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// Stage the four inputs as UTF-8 without BOM and with LF line endings inside a
/// caller-owned directory. Returns the paths in P4Merge argument order.
pub fn write_inputs(dir: &Path, inputs: &MergeInputs<'_>) -> Result<[PathBuf; 4], String> {
    let bodies = [inputs.base, inputs.theirs, inputs.yours, inputs.result];
    let mut paths = [
        PathBuf::new(),
        PathBuf::new(),
        PathBuf::new(),
        PathBuf::new(),
    ];
    for ((name, body), slot) in INPUT_NAMES.iter().zip(bodies).zip(paths.iter_mut()) {
        *slot = dir.join(name);
        std::fs::write(&*slot, normalize_line_endings(body).as_bytes())
            .map_err(|error| format!("Cannot stage P4Merge input {name}: {error}"))?;
    }
    Ok(paths)
}

/// P4Merge's documented argument order: base, theirs, yours, result.
pub fn argument_order<'a>(
    base: &'a Path,
    theirs: &'a Path,
    yours: &'a Path,
    result: &'a Path,
) -> [&'a Path; 4] {
    [base, theirs, yours, result]
}

/// Build the child process with an argument array only: no shell, no extra
/// P4Merge switches, and no inherited stdio.
pub fn build_command(executable: &Path, paths: &[PathBuf; 4], working_dir: &Path) -> Command {
    let mut command = Command::new(executable);
    command.args(argument_order(&paths[0], &paths[1], &paths[2], &paths[3]));
    command
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A redirected `.bat` launcher would otherwise flash a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Read P4Merge's saved result with the same 4 MiB / 100,000-line safety limits
/// as the manual-merge editor, strict UTF-8, CRLF normalized to LF.
pub fn read_merged_result(path: &Path) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("P4Merge did not leave a readable result: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("P4Merge result is not a regular file".into());
    }
    if metadata.len() > MAX_MANUAL_MERGE_BYTES {
        return Err(format!(
            "P4Merge result exceeds the {MAX_MANUAL_MERGE_BYTES}-byte text safety limit"
        ));
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("P4Merge result cannot be read: {error}"))?;
    if bytes.len() as u64 > MAX_MANUAL_MERGE_BYTES {
        return Err(format!(
            "P4Merge result exceeds the {MAX_MANUAL_MERGE_BYTES}-byte text safety limit"
        ));
    }
    let text =
        String::from_utf8(bytes).map_err(|_| "P4Merge result is not valid UTF-8".to_owned())?;
    // Tolerate a UTF-8 BOM but never surface it as content in the editor.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
    if text.lines().count() > MAX_MANUAL_MERGE_LINES {
        return Err(format!(
            "P4Merge result exceeds the {MAX_MANUAL_MERGE_LINES}-line text safety limit"
        ));
    }
    Ok(normalize_line_endings(&text))
}

/// Same text after line-ending normalization means the user saved nothing new.
pub fn unchanged(original: &str, merged: &str) -> bool {
    normalize_line_endings(original) == normalize_line_endings(merged)
}

fn create_temp_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("p4deck-p4merge-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|error| {
        format!("Cannot create the protected P4Merge staging directory: {error}")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Launch P4Merge on staged inputs, wait with a 200 ms poll and the 30 minute
/// ceiling, then classify what came back. The staging directory is always
/// removed best-effort; its contents are never logged or journaled.
pub fn execute(executable: &Path, inputs: &MergeInputs<'_>) -> MergeOutcome {
    let dir = match create_temp_dir() {
        Ok(dir) => dir,
        Err(reason) => {
            return MergeOutcome::Failed {
                exit_code: None,
                reason,
            }
        }
    };
    let outcome = execute_in(executable, inputs, &dir);
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

fn execute_in(executable: &Path, inputs: &MergeInputs<'_>, dir: &Path) -> MergeOutcome {
    let paths = match write_inputs(dir, inputs) {
        Ok(paths) => paths,
        Err(reason) => {
            return MergeOutcome::Failed {
                exit_code: None,
                reason,
            }
        }
    };
    let mut command = build_command(executable, &paths, dir);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return MergeOutcome::Failed {
                exit_code: None,
                reason: format!("P4Merge could not be started: {error}"),
            }
        }
    };
    let status = match wait_for_exit(&mut child) {
        WaitOutcome::Exited(status) => status,
        WaitOutcome::TimedOut => return MergeOutcome::Timeout,
        WaitOutcome::WaitFailed(reason) => {
            return MergeOutcome::Failed {
                exit_code: None,
                reason,
            }
        }
    };
    let exit_code = status.code();
    if !status.success() {
        return match exit_code {
            Some(code) => MergeOutcome::Failed {
                exit_code,
                reason: format!("P4Merge exited with code {code}"),
            },
            None => MergeOutcome::Cancelled,
        };
    }
    match read_merged_result(&paths[3]) {
        Ok(merged) if unchanged(inputs.result, &merged) => MergeOutcome::Unchanged { exit_code },
        Ok(merged) => MergeOutcome::Completed {
            result: merged,
            exit_code,
        },
        Err(reason) => MergeOutcome::Failed { exit_code, reason },
    }
}

enum WaitOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
    WaitFailed(String),
}

fn wait_for_exit(child: &mut Child) -> WaitOutcome {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return WaitOutcome::Exited(status),
            Ok(None) => {
                if started.elapsed() >= EXTERNAL_MERGE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return WaitOutcome::TimedOut;
                }
                std::thread::sleep(EXTERNAL_MERGE_POLL);
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return WaitOutcome::WaitFailed(format!("P4Merge wait failed: {error}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("p4deck-p4merge-test-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn detection_order_is_env_then_common_then_path_on_every_platform() {
        let root = temp_dir("detect-order");
        let env_bin = root.join("env").join("p4merge.exe");
        let common_bin = root.join("program-files").join("p4merge.exe");
        let path_dir = root.join("path");
        let path_bin = path_dir.join("p4merge.exe");
        write_file(&env_bin, b"env");
        write_file(&common_bin, b"common");
        write_file(&path_bin, b"path");
        let candidates = ordered_candidates(
            Some(&env_bin),
            std::slice::from_ref(&common_bin),
            std::slice::from_ref(&path_dir),
            "p4merge.exe",
        );
        assert_eq!(
            candidates
                .iter()
                .map(|(_, source)| *source)
                .collect::<Vec<_>>(),
            vec![ToolSource::Env, ToolSource::CommonPath, ToolSource::Path]
        );
        let found = first_existing(&candidates).unwrap();
        assert_eq!(found.executable, env_bin);
        assert_eq!(found.source, ToolSource::Env);

        // A missing env override falls through to the common install path.
        let missing_env = root.join("missing.exe");
        let found = first_existing(&ordered_candidates(
            Some(&missing_env),
            std::slice::from_ref(&common_bin),
            std::slice::from_ref(&path_dir),
            "p4merge.exe",
        ))
        .unwrap();
        assert_eq!(found.executable, common_bin);
        assert_eq!(found.source, ToolSource::CommonPath);

        // A directory with the expected name is not an executable file.
        let directory_shadow = root.join("directory-shadow");
        std::fs::create_dir_all(directory_shadow.join("p4merge.exe")).unwrap();
        let found = first_existing(&ordered_candidates(
            None,
            &[],
            &[directory_shadow, path_dir],
            "p4merge.exe",
        ))
        .unwrap();
        assert_eq!(found.executable, path_bin);
        assert_eq!(found.source, ToolSource::Path);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn env_override_wins_before_the_macos_bundle_and_missing_env_falls_back() {
        let root = temp_dir("detect-bundle");
        let env_bin = root.join("launchp4merge");
        let bundle = root.join("p4merge.app").join("launchp4merge");
        write_file(&env_bin, b"env");
        write_file(&bundle, b"bundle");
        // Unified order: the explicit P4MERGE override beats the macOS bundle.
        let found = first_existing(&ordered_candidates(
            Some(&env_bin),
            std::slice::from_ref(&bundle),
            &[],
            "p4merge",
        ))
        .unwrap();
        assert_eq!(found.executable, env_bin);
        assert_eq!(found.source, ToolSource::Env);
        let found = first_existing(&ordered_candidates(
            None,
            std::slice::from_ref(&bundle),
            &[],
            "p4merge",
        ))
        .unwrap();
        assert_eq!(found.executable, bundle);
        assert_eq!(found.source, ToolSource::CommonPath);
        assert!(first_existing(&ordered_candidates(
            None,
            &[root.join("missing")],
            &[],
            "p4merge"
        ))
        .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalizes_env_override_quotes_and_refuses_windows_batch_wrappers() {
        let quoted = r#"  "C:\Program Files\Perforce\p4merge.exe"  "#;
        let (candidate, reason) = prepare_env_candidate(Some(PathBuf::from(quoted)), true);
        assert_eq!(
            candidate,
            Some(PathBuf::from(r"C:\Program Files\Perforce\p4merge.exe"))
        );
        assert!(reason.is_none());

        // No shell: Windows `.bat`/`.cmd` wrappers are refused with a reason.
        for wrapper in [
            r"C:\tools\p4merge.bat",
            r"C:\tools\p4merge.cmd",
            r"C:\tools\p4merge",
        ] {
            let (candidate, reason) = prepare_env_candidate(Some(PathBuf::from(wrapper)), true);
            assert!(candidate.is_none(), "{wrapper} must be skipped");
            let reason = reason.unwrap();
            assert!(
                reason.contains(".bat"),
                "reason must explain the wrapper: {reason}"
            );
            assert!(reason.contains("p4merge.exe"));
        }
        let (candidate, reason) =
            prepare_env_candidate(Some(PathBuf::from(r"C:\Perforce\P4MERGE.EXE")), true);
        assert_eq!(candidate, Some(PathBuf::from(r"C:\Perforce\P4MERGE.EXE")));
        assert!(reason.is_none());

        // Non-Windows launchers (macOS `launchp4merge`) are kept as-is.
        let launcher = PathBuf::from("/opt/homebrew/bin/p4merge-launcher");
        let (candidate, reason) = prepare_env_candidate(Some(launcher.clone()), false);
        assert_eq!(candidate, Some(launcher));
        assert!(reason.is_none());

        // Blank/empty overrides behave like an unset variable.
        for raw in [r#"  ""  "#.to_owned(), "   ".to_owned()] {
            let (candidate, reason) = prepare_env_candidate(Some(PathBuf::from(raw)), true);
            assert!(candidate.is_none());
            assert!(reason.is_none());
        }
        let (candidate, reason) = prepare_env_candidate(None, true);
        assert!(candidate.is_none());
        assert!(reason.is_none());
    }

    #[test]
    fn windows_batch_override_falls_back_to_the_common_install_path() {
        let root = temp_dir("detect-fallback");
        let common_bin = root.join("Perforce").join("p4merge.exe");
        write_file(&common_bin, b"common");
        let (env, reason) = prepare_env_candidate(Some(root.join("p4merge.bat")), true);
        assert!(env.is_none());
        assert!(reason.unwrap().contains("p4merge.exe"));
        let found = first_existing(&ordered_candidates(
            env.as_deref(),
            std::slice::from_ref(&common_bin),
            &[],
            "p4merge.exe",
        ))
        .unwrap();
        assert_eq!(found.executable, common_bin);
        assert_eq!(found.source, ToolSource::CommonPath);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stages_utf8_inputs_without_bom_and_with_lf_only() {
        let dir = temp_dir("stage");
        let paths = write_inputs(
            &dir,
            &MergeInputs {
                base: "base\r\n",
                theirs: "theirs\n",
                yours: "yours\r\n",
                result: "result\r\nline\n",
            },
        )
        .unwrap();
        assert_eq!(paths[0], dir.join("base.txt"));
        assert_eq!(paths[1], dir.join("theirs.txt"));
        assert_eq!(paths[2], dir.join("yours.txt"));
        assert_eq!(paths[3], dir.join("result.txt"));
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"base\n");
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"theirs\n");
        assert_eq!(std::fs::read(&paths[2]).unwrap(), b"yours\n");
        assert_eq!(std::fs::read(&paths[3]).unwrap(), b"result\nline\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn launches_p4merge_with_base_theirs_yours_result_only() {
        let root = temp_dir("args");
        let paths = [
            root.join("base.txt"),
            root.join("theirs.txt"),
            root.join("yours.txt"),
            root.join("result.txt"),
        ];
        let command = build_command(Path::new("p4merge.exe"), &paths, &root);
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                root.join("base.txt").to_string_lossy().into_owned(),
                root.join("theirs.txt").to_string_lossy().into_owned(),
                root.join("yours.txt").to_string_lossy().into_owned(),
                root.join("result.txt").to_string_lossy().into_owned(),
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_back_strict_utf8_with_limits_and_crlf_normalization() {
        let dir = temp_dir("readback");
        let result = dir.join("result.txt");
        write_file(&result, b"a\r\nb\r\n");
        assert_eq!(read_merged_result(&result).unwrap(), "a\nb\n");

        write_file(&result, b"\xef\xbb\xbfwith-bom\n");
        assert_eq!(read_merged_result(&result).unwrap(), "with-bom\n");

        write_file(&result, b"valid\n\xff\xfe\n");
        assert!(read_merged_result(&result).is_err());

        let too_large = dir.join("too-large.txt");
        let file = std::fs::File::create(&too_large).unwrap();
        file.set_len(MAX_MANUAL_MERGE_BYTES + 1).unwrap();
        assert!(read_merged_result(&too_large).is_err());

        let too_many_lines = dir.join("too-many-lines.txt");
        write_file(
            &too_many_lines,
            "x\n".repeat(MAX_MANUAL_MERGE_LINES + 1).as_bytes(),
        );
        assert!(read_merged_result(&too_many_lines).is_err());

        // A directory (or a missing path) is never accepted as a result.
        assert!(read_merged_result(&dir).is_err());
        assert!(read_merged_result(&dir.join("missing.txt")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn classifies_unchanged_only_after_line_ending_normalization() {
        assert!(unchanged("a\r\nb\r\n", "a\nb\n"));
        assert!(unchanged("same", "same"));
        assert!(!unchanged("before\n", "after\n"));
        assert!(!unchanged("a\n", "a\nb\n"));
    }

    #[test]
    fn never_logs_or_persists_merge_text_outside_the_staging_directory() {
        // `execute` only accepts staged inputs; every failure path returns a
        // short reason and the temporary directory is removed best-effort.
        let outcome = execute(
            Path::new("p4deck-p4merge-test-does-not-exist"),
            &MergeInputs {
                base: "secret-base\n",
                theirs: "secret-theirs\n",
                yours: "secret-yours\n",
                result: "secret-result\n",
            },
        );
        match outcome {
            MergeOutcome::Failed { reason, .. } => {
                assert!(!reason.contains("secret"));
            }
            other => panic!("unexpected outcome for a missing executable: {other:?}"),
        }
    }
}
