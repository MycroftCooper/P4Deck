//! Narrow native integration for revealing workspace paths or selecting an application.
//!
//! The frontend cannot provide an executable or command-line arguments. Every target is
//! canonicalized inside the active workspace before a fixed operating-system API is called.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenLocalPathMode {
    Reveal,
    OpenWith,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLocalPathRequest {
    pub path: String,
    pub mode: OpenLocalPathMode,
}

#[derive(Debug, Eq, PartialEq)]
struct ValidatedRequest {
    path: PathBuf,
    mode: OpenLocalPathMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathCapabilities {
    pub reveal: bool,
    pub open_with: bool,
}

/// Local filesystem inspection only: never queries the P4 server or opens a dialog.
pub fn capabilities(root: &Path, path: String) -> LocalPathCapabilities {
    let request = OpenLocalPathRequest {
        path,
        mode: OpenLocalPathMode::Reveal,
    };
    let validated = validate_request(root, &request).ok();
    LocalPathCapabilities {
        reveal: validated.is_some(),
        open_with: validated.is_some_and(|value| value.path.is_file()),
    }
}

fn validate_request(
    root: &Path,
    request: &OpenLocalPathRequest,
) -> Result<ValidatedRequest, String> {
    let input = request.path.as_str();
    if input.is_empty() || input.chars().any(char::is_control) {
        return Err("Local path contains control characters".into());
    }
    if input.starts_with("//") {
        return Err("Depot paths cannot be opened by the operating system".into());
    }

    let requested_path = Path::new(input);
    if !requested_path.is_absolute() {
        return Err("Expected an absolute local path".into());
    }

    let workspace_root = root
        .canonicalize()
        .map_err(|error| format!("Cannot resolve workspace root: {error}"))?;
    if !workspace_root.is_dir() {
        return Err("Workspace root is not a directory".into());
    }
    let path = requested_path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve local path: {error}"))?;
    if !path.starts_with(&workspace_root) {
        return Err("Path is outside the current workspace".into());
    }
    if request.mode == OpenLocalPathMode::OpenWith && !path.is_file() {
        return Err("Open with requires an existing local file".into());
    }

    Ok(ValidatedRequest {
        path,
        mode: request.mode,
    })
}

pub fn open(root: &Path, request: OpenLocalPathRequest) -> Result<(), String> {
    let validated = validate_request(root, &request)?;
    platform_open(&validated.path, validated.mode)
}

/// Opens an app-owned directory; callers supply no frontend path or arguments.
pub fn open_log_directory(path: &Path) -> Result<(), String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path.is_dir() {
        return Err("The log directory is unavailable".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(path)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(path)
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("The log directory could not be opened".into())
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("Opening the log directory is supported on macOS and Windows".into())
    }
}

#[cfg(target_os = "macos")]
fn platform_open(path: &Path, mode: OpenLocalPathMode) -> Result<(), String> {
    use std::process::Command;

    let mut command = Command::new("/usr/bin/open");
    match mode {
        OpenLocalPathMode::Reveal => {
            command.arg("-R");
        }
        OpenLocalPathMode::OpenWith => {
            // The script is static. The OS chooser returns the application and the target path is
            // passed separately to `open`; neither value is evaluated by a shell.
            let chosen = Command::new("/usr/bin/osascript")
                .args([
                    "-e",
                    "POSIX path of (choose application with prompt \"Choose an application to open this file\" as alias)",
                ])
                .output()
                .map_err(|error| error.to_string())?;
            if !chosen.status.success() {
                let error = String::from_utf8_lossy(&chosen.stderr);
                if error.contains("(-128)") {
                    return Ok(());
                }
                return Err(error.into_owned());
            }
            let application =
                String::from_utf8(chosen.stdout).map_err(|error| error.to_string())?;
            command.arg("-a").arg(application.trim_end());
        }
    }

    let result = command
        .arg(path)
        .output()
        .map_err(|error| error.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).into_owned())
    }
}

#[cfg(target_os = "windows")]
fn platform_open(path: &Path, mode: OpenLocalPathMode) -> Result<(), String> {
    use std::{
        ffi::c_void,
        os::windows::{ffi::OsStrExt, process::CommandExt},
        ptr,
    };

    if mode == OpenLocalPathMode::Reveal {
        // Fixed executable and a single argument; no shell or command-string evaluation occurs.
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[repr(C)]
    struct OpenAsInfo {
        file: *const u16,
        class: *const u16,
        flags: u32,
    }
    #[link(name = "shell32")]
    extern "system" {
        #[link_name = "SHOpenWithDialog"]
        fn sh_open_with_dialog(parent: *mut c_void, info: *const OpenAsInfo) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        #[link_name = "CoInitializeEx"]
        fn co_initialize_ex(reserved: *mut c_void, flags: u32) -> i32;
        #[link_name = "CoUninitialize"]
        fn co_uninitialize();
    }

    let file: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let info = OpenAsInfo {
        file: file.as_ptr(),
        class: ptr::null(),
        flags: 4, // OAIF_EXEC: execute the application selected by the user.
    };
    unsafe {
        // This blocking worker owns the COM apartment and the UTF-16 buffer outlives the dialog.
        let initialized = co_initialize_ex(ptr::null_mut(), 2);
        if initialized < 0 {
            return Err(format!("Cannot initialize Open With: {initialized:#x}"));
        }
        let result = sh_open_with_dialog(ptr::null_mut(), &info);
        co_uninitialize();
        if result >= 0 || result as u32 == 0x800704c7 {
            Ok(()) // S_OK or ERROR_CANCELLED.
        } else {
            Err(format!("Open With failed: {result:#x}"))
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_open(_: &Path, _: OpenLocalPathMode) -> Result<(), String> {
    Err("System opening is supported on macOS and Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        file: PathBuf,
        directory: PathBuf,
        outside: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("p4deck-system-open-{}", uuid::Uuid::new_v4()));
            let root = base.join("workspace");
            let directory = root.join("folder");
            let file = root.join("file.txt");
            let outside = base.join("outside.txt");
            fs::create_dir_all(&directory).unwrap();
            fs::write(&file, "inside").unwrap();
            fs::write(&outside, "outside").unwrap();
            Self {
                base,
                root,
                file,
                directory,
                outside,
            }
        }

        fn request(&self, path: &Path, mode: OpenLocalPathMode) -> OpenLocalPathRequest {
            OpenLocalPathRequest {
                path: path.to_string_lossy().into_owned(),
                mode,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn accepts_files_and_directories_for_reveal() {
        let fixture = Fixture::new();
        assert!(validate_request(
            &fixture.root,
            &fixture.request(&fixture.file, OpenLocalPathMode::Reveal)
        )
        .is_ok());
        assert!(validate_request(
            &fixture.root,
            &fixture.request(&fixture.directory, OpenLocalPathMode::Reveal)
        )
        .is_ok());
    }

    #[test]
    fn capabilities_follow_local_existence_and_workspace_boundary() {
        let fixture = Fixture::new();
        let inspect =
            |path: &Path| capabilities(&fixture.root, path.to_string_lossy().into_owned());
        let file = inspect(&fixture.file);
        assert!(file.reveal && file.open_with);
        let directory = inspect(&fixture.directory);
        assert!(directory.reveal && !directory.open_with);
        for path in [&fixture.outside, &fixture.root.join("missing.txt")] {
            let result = inspect(path);
            assert!(!result.reveal && !result.open_with);
        }
        fs::remove_file(&fixture.file).unwrap();
        let removed = inspect(&fixture.file);
        assert!(!removed.reveal && !removed.open_with);
    }

    #[test]
    fn open_with_accepts_files_but_rejects_directories() {
        let fixture = Fixture::new();
        assert!(validate_request(
            &fixture.root,
            &fixture.request(&fixture.file, OpenLocalPathMode::OpenWith)
        )
        .is_ok());
        assert!(validate_request(
            &fixture.root,
            &fixture.request(&fixture.directory, OpenLocalPathMode::OpenWith)
        )
        .is_err());
    }

    #[test]
    fn rejects_depot_relative_missing_control_and_outside_paths() {
        let fixture = Fixture::new();
        for path in [
            "//depot/main/file.txt".to_string(),
            "../outside.txt".to_string(),
            fixture
                .root
                .join("missing.txt")
                .to_string_lossy()
                .into_owned(),
            format!("{}\n", fixture.file.display()),
            fixture.outside.to_string_lossy().into_owned(),
        ] {
            let request = OpenLocalPathRequest {
                path,
                mode: OpenLocalPathMode::Reveal,
            };
            assert!(validate_request(&fixture.root, &request).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_workspace() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let link = fixture.root.join("outside-link");
        symlink(&fixture.outside, &link).unwrap();
        assert!(validate_request(
            &fixture.root,
            &fixture.request(&link, OpenLocalPathMode::Reveal)
        )
        .is_err());
    }

    #[test]
    fn deserializes_camel_case_modes() {
        let request: OpenLocalPathRequest = serde_json::from_value(serde_json::json!({
            "path": "/workspace/file.txt",
            "mode": "openWith"
        }))
        .unwrap();
        assert_eq!(request.mode, OpenLocalPathMode::OpenWith);
        assert_eq!(
            serde_json::to_value(OpenLocalPathMode::OpenWith).unwrap(),
            "openWith"
        );
    }
}
