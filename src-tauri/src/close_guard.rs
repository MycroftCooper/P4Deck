//! Direct application/window closing. Edit reports are diagnostic only; no close prompts or waits.
use crate::app::close_policy::{direct_scope, EditState, Scope, WindowId, WindowReport};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use tauri::Manager;

#[derive(Clone, Default)]
pub(crate) struct CloseGuard(Arc<Mutex<Host>>);

#[derive(Default)]
struct Host {
    generation: u64,
    revision: u64,
    windows: BTreeMap<String, (WindowId, WindowReport)>,
    dirty_categories: BTreeMap<String, Vec<DirtyCategory>>,
    last_dirty_sequence: BTreeMap<String, u64>,
    active: usize,
    closing: Option<Scope>,
}

impl Host {
    fn register(&mut self, label: &str) -> u64 {
        if let Some((id, _)) = self.windows.get(label) {
            return id.generation;
        }
        self.navigate(label)
    }

    fn navigate(&mut self, label: &str) -> u64 {
        self.dirty_categories.remove(label);
        self.last_dirty_sequence.remove(label);
        self.generation += 1;
        self.revision += 1;
        self.windows.insert(
            label.into(),
            (
                WindowId {
                    label: label.into(),
                    generation: self.generation,
                },
                WindowReport {
                    sequence: 0,
                    state: EditState::Unknown,
                    probe: None,
                },
            ),
        );
        self.generation
    }

    fn blocked(&self, label: &str) -> bool {
        matches!(&self.closing, Some(Scope::Application))
            || matches!(&self.closing, Some(Scope::Window(id)) if id.label == label)
    }

    fn report(
        &mut self,
        label: &str,
        generation: u64,
        sequence: u64,
        state: WireState,
        probe: Option<u64>,
    ) -> bool {
        if self.blocked(label) || sequence == 0 || sequence > 9_007_199_254_740_991 {
            return false;
        }
        let Some((id, report)) = self.windows.get_mut(label) else {
            return false;
        };
        if id.generation != generation || sequence <= report.sequence {
            return false;
        }
        if probe.is_some() {
            return false;
        }
        let effective = match state {
            WireState::Dirty => EditState::Dirty,
            WireState::Clean => EditState::Clean,
            WireState::Unknown if report.state == EditState::Dirty => EditState::Dirty,
            WireState::Unknown => EditState::Unknown,
        };
        if state == WireState::Dirty {
            self.last_dirty_sequence.insert(label.into(), sequence);
        }
        if effective != EditState::Dirty {
            self.last_dirty_sequence.remove(label);
            self.dirty_categories.remove(label);
        }
        *report = WindowReport {
            sequence,
            state: effective,
            probe,
        };
        self.revision += 1;
        true
    }

    fn report_resolution(
        &mut self,
        label: &str,
        generation: u64,
        sequence: u64,
        state: WireState,
        probe: Option<u64>,
        resolved: Option<u64>,
    ) -> bool {
        let previous_sequence = self
            .windows
            .get(label)
            .map(|(_, report)| report.sequence)
            .unwrap_or(0);
        let can_resolve = state == WireState::Unknown
            && resolved.is_some_and(|through| {
                through > 0
                    && through < sequence
                    && through <= previous_sequence
                    && self
                        .last_dirty_sequence
                        .get(label)
                        .is_some_and(|dirty| *dirty <= through)
            });
        if !self.report(label, generation, sequence, state, probe) {
            return false;
        }
        if can_resolve {
            self.windows.get_mut(label).unwrap().1.state = EditState::Unknown;
            self.dirty_categories.remove(label);
            self.last_dirty_sequence.remove(label);
        }
        true
    }
    fn begin_direct(&mut self, label: &str, application: bool) -> Option<Scope> {
        if self.blocked(label) {
            return None;
        }
        let scope = direct_scope(label, application, &self.windows)?;
        self.closing = Some(scope.clone());
        Some(scope)
    }

    fn failed_close(&mut self) {
        self.closing = None;
        self.revision += 1;
    }
}

/// Command argument injected by Rust, never deserialized from caller input.
/// Kept until the whole async command finishes, including its awaited tasks.
pub(crate) struct Admission(CloseGuard);
impl Drop for Admission {
    fn drop(&mut self) {
        let mut host = self.0 .0.lock();
        host.active -= 1;
        host.revision += 1;
    }
}
impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for Admission {
    fn from_command(
        item: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let webview = item.message.webview_ref();
        let guard = webview
            .try_state::<CloseGuard>()
            .ok_or_else(|| tauri::ipc::InvokeError::from("Close protection is not initialized"))?;
        guard.enter(webview.label()).map_err(Into::into)
    }
}
impl CloseGuard {
    fn enter(&self, label: &str) -> Result<Admission, String> {
        let mut host = self.0.lock();
        if host.blocked(label) {
            return Err("Window is closing; new work was not started".into());
        }
        host.active += 1;
        host.revision += 1;
        Ok(Admission(self.clone()))
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DirtyCategory {
    ConnectionSettings,
    ChangelistDescription,
    ManualMerge,
    CustomToolSettings,
    OtherDraft,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WireState {
    Clean,
    Dirty,
    Unknown,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WireScope {
    Window,
    Application,
}
#[derive(Serialize)]
pub(crate) struct Registered {
    generation: String,
}
#[derive(Serialize)]
pub(crate) struct Accepted {
    accepted: bool,
}
fn decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

#[tauri::command]
pub(crate) fn close_guard_register(
    window: tauri::WebviewWindow,
    guard: tauri::State<'_, CloseGuard>,
) -> Registered {
    Registered {
        generation: guard.0.lock().register(window.label()).to_string(),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn close_guard_report(
    window: tauri::WebviewWindow,
    guard: tauri::State<'_, CloseGuard>,
    generation: String,
    sequence: u64,
    state: WireState,
    probe_id: Option<String>,
    dirty_categories: Option<Vec<DirtyCategory>>,
    resolved_dirty_through_sequence: Option<u64>,
) -> Accepted {
    let accepted = decimal(&generation).is_some_and(|generation| {
        let probe = match probe_id.as_deref() {
            Some(value) => match decimal(value) {
                Some(v) => Some(v),
                None => return false,
            },
            None => None,
        };
        let mut host = guard.0.lock();
        if dirty_categories
            .as_ref()
            .is_some_and(|items| items.len() > 5)
        {
            return false;
        }
        let accepted = host.report_resolution(
            window.label(),
            generation,
            sequence,
            state,
            probe,
            resolved_dirty_through_sequence,
        );
        if accepted && state == WireState::Dirty {
            let mut categories = Vec::new();
            for category in dirty_categories.unwrap_or_default() {
                if !categories.contains(&category) {
                    categories.push(category);
                }
            }
            host.dirty_categories
                .insert(window.label().into(), categories);
        }
        accepted
    });
    Accepted { accepted }
}

#[tauri::command]
pub(crate) fn close_guard_request(window: tauri::WebviewWindow, scope: WireScope) -> Accepted {
    Accepted {
        accepted: request(
            window.app_handle(),
            window.label(),
            matches!(scope, WireScope::Application),
        ),
    }
}

pub(crate) fn page_load(webview: &tauri::Webview, event: &tauri::webview::PageLoadPayload<'_>) {
    if matches!(event.event(), tauri::webview::PageLoadEvent::Started) {
        webview
            .state::<CloseGuard>()
            .0
            .lock()
            .navigate(webview.label());
    }
}

pub(crate) fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let guard = window.state::<CloseGuard>();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            request(window.app_handle(), window.label(), false);
        }
        tauri::WindowEvent::Destroyed => {
            let mut host = guard.0.lock();
            host.windows.remove(window.label());
            host.dirty_categories.remove(window.label());
            host.last_dirty_sequence.remove(window.label());
            host.revision += 1;
            if matches!(&host.closing, Some(Scope::Window(id)) if id.label == window.label()) {
                host.closing = None;
            }
        }
        _ => {}
    }
}

// Native ExitRequested is deliberately not prevented. Tauri owns normal cleanup.
pub(crate) fn run_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {}

fn request(app: &tauri::AppHandle, label: &str, application: bool) -> bool {
    let guard = app.state::<CloseGuard>().inner().clone();
    let scope = {
        let mut host = guard.0.lock();
        for label in app.webview_windows().keys() {
            host.register(label);
        }
        host.begin_direct(label, application)
    };
    let Some(scope) = scope else {
        return false;
    };
    execute_close(app, &guard, scope);
    true
}

fn execute_close(app: &tauri::AppHandle, guard: &CloseGuard, scope: Scope) {
    let mut windows: Vec<_> = app
        .webview_windows()
        .into_values()
        .filter(|w| match &scope {
            Scope::Application => true,
            Scope::Window(id) => w.label() == id.label,
        })
        .collect();
    windows.sort_by_key(|w| w.label() == "main");
    for window in windows {
        // destroy bypasses CloseRequested to prevent duplicate close dispatch.
        // closing stays set while events are dispatched; all new work is blocked.
        if window.destroy().is_err() {
            guard.0.lock().failed_close();
            eprintln!("Window close failed; admission restored for an explicit retry");
            return;
        }
    }
}

#[cfg(target_os = "windows")]
fn message_box(
    owner: Option<(&tauri::AppHandle, &str)>,
    title: &str,
    text: &str,
    style: u32,
) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let hwnd = owner
        .and_then(|(app, label)| app.get_webview_window(label))
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as windows_sys::Win32::Foundation::HWND)
        .unwrap_or(std::ptr::null_mut());
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe { MessageBoxW(hwnd, text.as_ptr(), title.as_ptr(), style) }
}

pub(crate) fn native_notice(title: &str, text: &str) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        message_box(None, title, text, MB_OK | MB_ICONWARNING);
    }
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("{title}: {text}");
    }
}

pub(crate) fn initialization_failure() {
    // No profile path, credentials, or raw initialization error in this dialog.
    native_notice(
        "P4Deck 无法启动",
        "应用初始化失败，未进入工作界面。请保留配置并联系维护者检查本机启动环境。",
    );
}

pub(crate) fn initialized<T, E>(result: Result<T, E>, notify: impl FnOnce()) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(_) => {
            notify();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> Host {
        let mut h = Host::default();
        h.register("main");
        h.register("panel-test");
        h
    }
    #[test]
    fn every_edit_state_and_busy_close_without_renderer_or_operation_wait() {
        for state in [WireState::Clean, WireState::Dirty, WireState::Unknown] {
            for active in [0, 1, 5] {
                let mut h = host();
                let g = h.register("main");
                h.report("main", g, 1, state, None);
                h.active = active;
                assert_eq!(h.begin_direct("main", false), Some(Scope::Application));
                assert_eq!(h.active, active);
            }
        }
    }
    #[test]
    fn missing_renderer_report_and_duplicate_close_do_not_wait() {
        let mut h = host();
        assert_eq!(h.begin_direct("main", false), Some(Scope::Application));
        assert_eq!(h.begin_direct("main", false), None);
        h.failed_close();
        assert_eq!(h.begin_direct("main", false), Some(Scope::Application));
    }
    #[test]
    fn panel_close_preserves_other_windows_and_operations() {
        let guard = CloseGuard(Arc::new(Mutex::new(host())));
        let work = guard.enter("main").unwrap();
        assert!(matches!(
            guard.0.lock().begin_direct("panel-test", false),
            Some(Scope::Window(_))
        ));
        assert!(guard.enter("panel-test").is_err());
        assert!(guard.enter("main").is_ok());
        drop(work);
    }
    #[test]
    fn current_report_identity_still_rejects_stale_navigation_and_sequence() {
        let mut h = host();
        let g = h.register("main");
        assert!(h.report("main", g, 1, WireState::Dirty, None));
        assert!(!h.report("main", g, 1, WireState::Clean, None));
        h.navigate("main");
        assert!(!h.report("main", g, 2, WireState::Clean, None));
    }
    #[test]
    fn ui07_initialization_failure_notifies_without_running_application() {
        let mut notified = false;
        let result =
            initialized::<(), _>(Err("synthetic initialization failure"), || notified = true);
        assert!(result.is_none());
        assert!(notified);
        assert_eq!(
            initialized::<_, ()>(Ok(42), || panic!("not an error")),
            Some(42)
        );
    }

    #[test]
    fn ui07_every_business_command_has_host_admission() {
        let source = include_str!("ipc/commands.rs");
        let commands: Vec<_> = source.split("#[tauri::command]").skip(1).collect();
        // 115 previous business commands + MERGE-01 external merge
        // (detect_external_merge_tool, run_external_merge) + GETLATEST-DIRECT
        // (sync_latest) + RESOLVE-STATS (resolve_stats) + SETTINGS-ABOUT
        // (open_external_url). Every command must keep taking `_admission`;
        // never bypass the host admission check.
        assert_eq!(commands.len(), 120);
        for command in commands {
            let signature = command.split('{').next().unwrap();
            assert!(
                signature.contains("_admission: crate::close_guard::Admission"),
                "unguarded command: {signature}"
            );
        }
    }
}
