use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};

pub const PLACEMENT_VERSION: u8 = 1;
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPlacement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PlacementStore {
    version: u8,
    #[serde(default)]
    panels: BTreeMap<String, WindowPlacement>,
}

pub(crate) fn validate_backup_document(bytes: &[u8]) -> Result<(), String> {
    let store: PlacementStore = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if store.version != PLACEMENT_VERSION {
        return Err("unsupported window placement schema version".into());
    }
    Ok(())
}

pub fn load(path: &Path, key: &str) -> Option<WindowPlacement> {
    let _guard = STORE_LOCK.get_or_init(|| Mutex::new(())).lock().ok()?;
    let store: PlacementStore = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (store.version == PLACEMENT_VERSION)
        .then(|| store.panels.get(key).copied())
        .flatten()
}

pub fn save(path: &Path, key: &str, placement: WindowPlacement) -> Result<(), String> {
    let _guard = STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Window placement store lock was poisoned".to_owned())?;
    let mut store = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PlacementStore>(&bytes).ok())
        .filter(|store| store.version == PLACEMENT_VERSION)
        .unwrap_or(PlacementStore {
            version: PLACEMENT_VERSION,
            panels: BTreeMap::new(),
        });
    store.panels.insert(key.to_owned(), placement);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&store).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

pub fn sanitize(
    placement: WindowPlacement,
    screens: &[ScreenRect],
    fallback: ScreenRect,
) -> WindowPlacement {
    let screen = screens
        .iter()
        .max_by_key(|screen| intersection_area(placement, **screen))
        .filter(|screen| intersection_area(placement, **screen) > 0)
        .copied()
        .unwrap_or(fallback);
    let min_width = 640.min(screen.width.max(1));
    let min_height = 450.min(screen.height.max(1));
    let width = placement.width.clamp(min_width, screen.width.max(1));
    let height = placement.height.clamp(min_height, screen.height.max(1));
    let max_x = screen
        .x
        .saturating_add(screen.width.saturating_sub(width) as i32);
    let max_y = screen
        .y
        .saturating_add(screen.height.saturating_sub(height) as i32);
    WindowPlacement {
        x: placement.x.clamp(screen.x, max_x),
        y: placement.y.clamp(screen.y, max_y),
        width,
        height,
        maximized: placement.maximized,
    }
}

fn intersection_area(window: WindowPlacement, screen: ScreenRect) -> u64 {
    let right = (window.x as i64 + window.width as i64).min(screen.x as i64 + screen.width as i64);
    let bottom =
        (window.y as i64 + window.height as i64).min(screen.y as i64 + screen.height as i64);
    let left = (window.x as i64).max(screen.x as i64);
    let top = (window.y as i64).max(screen.y as i64);
    (right - left).max(0) as u64 * (bottom - top).max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: ScreenRect = ScreenRect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };

    #[test]
    fn unplugged_monitor_falls_back_to_a_safe_primary_placement() {
        let value = sanitize(
            WindowPlacement {
                x: 4200,
                y: -900,
                width: 1100,
                height: 760,
                maximized: false,
            },
            &[PRIMARY],
            PRIMARY,
        );
        assert_eq!(value.x, 820);
        assert_eq!(value.y, 0);
        assert_eq!(value.width, 1100);
        assert_eq!(value.height, 760);
    }

    #[test]
    fn placement_uses_the_screen_with_the_largest_intersection_and_clamps_size() {
        let secondary = ScreenRect {
            x: -1280,
            y: 0,
            width: 1280,
            height: 720,
        };
        let value = sanitize(
            WindowPlacement {
                x: -1200,
                y: 40,
                width: 2000,
                height: 1000,
                maximized: true,
            },
            &[PRIMARY, secondary],
            PRIMARY,
        );
        assert_eq!(value.x, -1280);
        assert_eq!(value.y, 0);
        assert_eq!(value.width, 1280);
        assert_eq!(value.height, 720);
        assert!(value.maximized);
    }

    #[test]
    fn versioned_store_round_trips_and_ignores_unknown_versions() {
        let path =
            std::env::temp_dir().join(format!("p4deck-placement-{}.json", uuid::Uuid::new_v4()));
        let value = WindowPlacement {
            x: 10,
            y: 20,
            width: 900,
            height: 700,
            maximized: false,
        };
        save(&path, "terminal", value).unwrap();
        assert_eq!(load(&path, "terminal"), Some(value));
        fs::write(&path, r#"{"version":2,"panels":{}}"#).unwrap();
        assert_eq!(load(&path, "terminal"), None);
        let _ = fs::remove_file(path);
    }
}
