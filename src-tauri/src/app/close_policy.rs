//! Direct close scope selection. No editor, operation, journal or renderer readiness can block exit.
use std::collections::BTreeMap;
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct WindowId {
    pub label: String,
    pub generation: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Scope {
    Window(WindowId),
    Application,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EditState {
    Clean,
    Dirty,
    Unknown,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WindowReport {
    pub sequence: u64,
    pub state: EditState,
    pub probe: Option<u64>,
}
pub fn direct_scope(
    label: &str,
    application: bool,
    windows: &BTreeMap<String, (WindowId, WindowReport)>,
) -> Option<Scope> {
    let (id, _) = windows.get(label)?;
    Some(if application || label == "main" || windows.len() <= 1 {
        Scope::Application
    } else {
        Scope::Window(id.clone())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_and_application_scope_are_explicit() {
        let mut windows = BTreeMap::new();
        for label in ["main", "panel"] {
            windows.insert(
                label.into(),
                (
                    WindowId {
                        label: label.into(),
                        generation: 1,
                    },
                    WindowReport {
                        sequence: 0,
                        state: EditState::Unknown,
                        probe: None,
                    },
                ),
            );
        }
        assert!(matches!(
            direct_scope("panel", false, &windows),
            Some(Scope::Window(_))
        ));
        assert_eq!(
            direct_scope("main", false, &windows),
            Some(Scope::Application)
        );
        assert_eq!(
            direct_scope("panel", true, &windows),
            Some(Scope::Application)
        );
        assert_eq!(direct_scope("missing", false, &windows), None);
        windows.remove("main");
        assert_eq!(
            direct_scope("panel", false, &windows),
            Some(Scope::Application)
        );
    }
}
