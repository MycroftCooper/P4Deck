//! One fixed "open this URL with the operating system" adapter.
//!
//! Callers must validate the URL against an allowlist first; this module never
//! accepts an executable path or command line from the frontend, it only hands
//! an already-validated URL to the platform's default handler.

#[cfg(target_os = "windows")]
pub(crate) fn open(url: &str) -> Result<(), String> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let operation: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let target: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err("open failed".into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn open(url: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|_| "open failed")?;
    if status.success() {
        Ok(())
    } else {
        Err("open failed".into())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn open(_: &str) -> Result<(), String> {
    Err("unsupported platform".into())
}
