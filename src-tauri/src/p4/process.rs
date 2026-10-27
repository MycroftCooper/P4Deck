use std::{ffi::OsStr, process::Command};

/// Ties every P4 CLI child to the application process lifetime. If P4Deck
/// exits while a command is blocked, Windows closes this job handle and
/// terminates the child instead of leaving a mutation running in the
/// background.
#[cfg(windows)]
pub(super) struct ChildProcessJob {
    handle: std::os::windows::io::OwnedHandle,
}

#[cfg(not(windows))]
pub(super) struct ChildProcessJob;

/// Background P4 commands communicate through pipes, never a console window.
pub(super) fn command(executable: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(windows)]
impl ChildProcessJob {
    pub(super) fn new() -> std::io::Result<Self> {
        use std::{
            mem::{size_of, zeroed},
            os::windows::io::{AsRawHandle, FromRawHandle},
            ptr,
        };
        use windows_sys::Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let handle = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(raw.cast()) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    pub(super) fn assign(&self, child: &tokio::process::Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::HANDLE, System::JobObjects::AssignProcessToJobObject,
        };

        let process = child.raw_handle().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "P4 child exited before it could join the lifetime job",
            )
        })?;
        let assigned = unsafe {
            AssignProcessToJobObject(self.handle.as_raw_handle() as HANDLE, process as HANDLE)
        };
        if assigned == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(not(windows))]
impl ChildProcessJob {
    pub(super) fn new() -> std::io::Result<Self> {
        Ok(Self)
    }

    pub(super) fn assign(&self, _child: &tokio::process::Child) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{process::Stdio, time::Duration};

    fn console_probe() -> Command {
        let mut command = command("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -Namespace P4DeckTest -Name Console -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow();'; [P4DeckTest.Console]::GetConsoleWindow().ToInt64()",
        ]);
        command
    }

    fn assert_no_console(output: std::process::Output) {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    #[tokio::test]
    async fn synchronous_and_async_background_children_have_no_console() {
        assert_no_console(console_probe().output().unwrap());
        assert_no_console(
            tokio::process::Command::from(console_probe())
                .output()
                .await
                .unwrap(),
        );
    }

    #[tokio::test]
    async fn closing_the_process_job_terminates_a_running_child() {
        let job = ChildProcessJob::new().unwrap();
        let marker =
            std::env::temp_dir().join(format!("p4deck-process-job-{}", uuid::Uuid::new_v4()));
        let mut command = tokio::process::Command::from(command("powershell.exe"));
        let script = format!(
            "Start-Sleep -Seconds 60; [IO.File]::WriteAllText('{}', 'finished')",
            marker.to_string_lossy().replace('\'', "''")
        );
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .kill_on_drop(true)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        job.assign(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());

        drop(job);

        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("job close did not terminate the child");
        assert!(
            !marker.exists(),
            "child continued running after its process job closed"
        );
    }
}
