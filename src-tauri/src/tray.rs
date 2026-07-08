//! System tray icon + menu, and the small pieces of cross-platform "let the
//! user know what's happening without a window open" plumbing: tray tooltip
//! progress and the dock/taskbar failed-transfer badge.
//!
//! Per PLAN.md / spec: closing the main window hides it to the tray instead
//! of quitting, since transfers continue in the background. Only the tray's
//! "Quit Lopload" menu item actually exits the process.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};

const MENU_ID_SHOW: &str = "show";
const MENU_ID_RETRY: &str = "retry";
const MENU_ID_UPLOAD_NONE: &str = "upload-none";
const MENU_ID_QUIT: &str = "quit";
const UPLOAD_ITEM_PREFIX: &str = "upload-conn:";

/// Emitted when the user clicks "Retry failed" in the tray menu — the
/// frontend is the only side that knows which transfers are failed, so it
/// listens for this and calls `retry()` on each of them.
pub const RETRY_FAILED_EVENT: &str = "tray://retry-failed";

/// Emitted when the user clicks a per-connection "Upload files…" item, with
/// the connection id as payload — the frontend owns the file picker and the
/// per-connection transfer engine, so it does the actual enqueueing.
pub const UPLOAD_FILES_EVENT: &str = "tray://upload-files";

/// One saved connection, as pushed from the frontend for the "Upload
/// files…" submenu — deliberately minimal (no endpoint/bucket/credentials).
#[derive(Deserialize)]
pub struct TrayConnection {
    id: String,
    name: String,
}

/// The tray menu items that get their text/enabled state updated live, kept
/// around (rather than rebuilt) since Tauri 2's `MenuItem` supports
/// `set_text`/`set_enabled` in place.
struct TrayMenuItems<R: Runtime> {
    status: MenuItem<R>,
    retry: MenuItem<R>,
    upload_submenu: Submenu<R>,
    quit: MenuItem<R>,
}

struct TrayIcons {
    normal: Image<'static>,
    failed: Image<'static>,
}

struct TrayState<R: Runtime> {
    items: TrayMenuItems<R>,
    icons: TrayIcons,
    showing_failed_icon: Mutex<bool>,
}

/// Build the tray icon + menu and wire up window-close-hides-to-tray
/// behavior. Call once from the `setup` hook.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(
        app,
        "status",
        format_status_line(0, 0.0, 0),
        false,
        None::<&str>,
    )?;
    let show_item = MenuItem::with_id(app, MENU_ID_SHOW, "Show Lopload", true, None::<&str>)?;
    let retry_item = MenuItem::with_id(
        app,
        MENU_ID_RETRY,
        format_retry_label(0),
        false,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, MENU_ID_QUIT, format_quit_label(0), true, None::<&str>)?;

    // Starts empty (populated via tray_set_connections once the frontend
    // loads the saved connection list) with a disabled placeholder so the
    // submenu never looks broken before that first push arrives.
    let upload_submenu = Submenu::with_id(app, "upload", "Upload files…", true)?;
    let upload_placeholder = MenuItem::with_id(
        app,
        MENU_ID_UPLOAD_NONE,
        "No storage connections yet",
        false,
        None::<&str>,
    )?;
    upload_submenu.append(&upload_placeholder)?;

    let separator_top = PredefinedMenuItem::separator(app)?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &separator_top,
            &show_item,
            &retry_item,
            &upload_submenu,
            &separator_bottom,
            &quit_item,
        ],
    )?;

    // Menu bar icons follow a different convention than the Dock icon: a
    // minimal monochrome "template image" (solid black glyph, transparent
    // background, no backdrop) that macOS re-tints for light/dark menu bars.
    // Reusing the colorful Dock icon here would look out of place next to
    // other apps' menu-bar glyphs, so load a dedicated silhouette asset and
    // mark it as a template via `icon_as_template`. A second variant with a
    // small badge dot swaps in while there are unacknowledged failures.
    let normal_icon =
        Image::from_bytes(include_bytes!("../icons/tray-icon-template.png"))?.to_owned();
    let failed_icon =
        Image::from_bytes(include_bytes!("../icons/tray-icon-template-failed.png"))?.to_owned();

    TrayIconBuilder::with_id("main-tray")
        .icon(normal_icon.clone())
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("Lopload")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if let Some(connection_id) = id.strip_prefix(UPLOAD_ITEM_PREFIX) {
                let _ = app.emit(UPLOAD_FILES_EVENT, connection_id.to_string());
                return;
            }
            match id {
                MENU_ID_SHOW => show_main_window(app),
                MENU_ID_RETRY => {
                    let _ = app.emit(RETRY_FAILED_EVENT, ());
                }
                MENU_ID_QUIT => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;

    app.manage(TrayState {
        items: TrayMenuItems {
            status: status_item,
            retry: retry_item,
            upload_submenu,
            quit: quit_item,
        },
        icons: TrayIcons {
            normal: normal_icon,
            failed: failed_icon,
        },
        showing_failed_icon: Mutex::new(false),
    });

    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event({
            let app = app.clone();
            move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
        });
    }

    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The tray menu's disabled first line, e.g. "Transferring 3 files — 42%",
/// "2 transfers failed", or "Lopload is idle" when nothing needs attention.
/// Wording is direction-neutral since the engine carries uploads and
/// downloads through the same counts. In-flight transfers take priority
/// over failures — once they settle, any sticky failures surface here
/// until retried or dismissed.
fn format_status_line(uploading: i64, percent: f64, failed: i64) -> String {
    if uploading > 0 {
        let pct = percent.clamp(0.0, 100.0).round() as i64;
        let plural = if uploading == 1 { "" } else { "s" };
        format!("Transferring {uploading} file{plural} - {pct}%")
    } else if failed > 0 {
        let plural = if failed == 1 { "" } else { "s" };
        format!("{failed} transfer{plural} failed")
    } else {
        "Lopload is idle".to_string()
    }
}

/// "Retry failed (N)" — the item stays in the menu but disabled at N == 0,
/// since `MenuItem` has no visibility toggle in Tauri 2.
fn format_retry_label(failed: i64) -> String {
    format!("Retry failed ({failed})")
}

fn format_quit_label(_uploading: i64) -> String {
    "Quit".to_string()
}

/// Pushes engine-derived state to the tray menu: the status line, the
/// "Retry failed" item's label/enabled state, the Quit label, and (when the
/// failed count crosses zero in either direction) the tray icon.
#[tauri::command]
pub fn tray_set_status<R: Runtime>(
    app: AppHandle<R>,
    uploading: i64,
    percent: f64,
    failed: i64,
) -> Result<(), String> {
    let state = app
        .try_state::<TrayState<R>>()
        .ok_or_else(|| "tray not initialized".to_string())?;

    state
        .items
        .status
        .set_text(format_status_line(uploading, percent, failed))
        .map_err(|e| e.to_string())?;
    state
        .items
        .retry
        .set_text(format_retry_label(failed))
        .map_err(|e| e.to_string())?;
    state
        .items
        .retry
        .set_enabled(failed > 0)
        .map_err(|e| e.to_string())?;
    state
        .items
        .quit
        .set_text(format_quit_label(uploading))
        .map_err(|e| e.to_string())?;

    let show_failed_icon = failed > 0;
    let mut showing_failed_icon = state.showing_failed_icon.lock().unwrap();
    if *showing_failed_icon != show_failed_icon {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let icon = if show_failed_icon {
                state.icons.failed.clone()
            } else {
                state.icons.normal.clone()
            };
            tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        }
        *showing_failed_icon = show_failed_icon;
    }

    Ok(())
}

/// Rebuilds the "Upload files…" submenu from the frontend's current
/// connection list — called on startup and whenever a connection is added,
/// renamed, or removed. Falls back to a disabled placeholder when empty.
#[tauri::command]
pub fn tray_set_connections<R: Runtime>(
    app: AppHandle<R>,
    connections: Vec<TrayConnection>,
) -> Result<(), String> {
    let state = app
        .try_state::<TrayState<R>>()
        .ok_or_else(|| "tray not initialized".to_string())?;

    let submenu = &state.items.upload_submenu;
    let existing_count = submenu.items().map_err(|e| e.to_string())?.len();
    for _ in 0..existing_count {
        submenu.remove_at(0).map_err(|e| e.to_string())?;
    }

    if connections.is_empty() {
        let placeholder = MenuItem::with_id(
            &app,
            MENU_ID_UPLOAD_NONE,
            "No storage connections yet",
            false,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        submenu.append(&placeholder).map_err(|e| e.to_string())?;
    } else {
        for conn in &connections {
            let item = MenuItem::with_id(
                &app,
                format!("{UPLOAD_ITEM_PREFIX}{}", conn.id),
                conn.name.clone(),
                true,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?;
            submenu.append(&item).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod status_format_tests {
    use super::*;

    #[test]
    fn status_line_prioritizes_uploading_over_failed() {
        assert_eq!(format_status_line(3, 42.4, 2), "Transferring 3 files - 42%");
        assert_eq!(format_status_line(1, 0.0, 0), "Transferring 1 file - 0%");
    }

    #[test]
    fn status_line_reports_failures_when_idle() {
        assert_eq!(format_status_line(0, 0.0, 1), "1 transfer failed");
        assert_eq!(format_status_line(0, 0.0, 4), "4 transfers failed");
    }

    #[test]
    fn status_line_reports_idle() {
        assert_eq!(format_status_line(0, 0.0, 0), "Lopload is idle");
    }

    #[test]
    fn retry_label_includes_count() {
        assert_eq!(format_retry_label(0), "Retry failed (0)");
        assert_eq!(format_retry_label(5), "Retry failed (5)");
    }

    #[test]
    fn quit_label_is_always_quit() {
        assert_eq!(format_quit_label(0), "Quit");
        assert_eq!(format_quit_label(9), "Quit");
    }

    #[test]
    fn percent_clamps_to_valid_range() {
        assert_eq!(format_status_line(1, 142.0, 0), "Transferring 1 file - 100%");
        assert_eq!(format_status_line(1, -10.0, 0), "Transferring 1 file - 0%");
    }
}

/// Update the tray tooltip to reflect overall upload progress, e.g.
/// "Uploading — 42%". Pass `None` to clear it back to the plain app name.
///
/// Tauri 2's tray icon doesn't expose a numeric progress affordance on all
/// platforms (no taskbar progress API), so the tooltip is the portable
/// fallback used everywhere.
#[tauri::command]
pub fn tray_set_progress<R: Runtime>(
    app: AppHandle<R>,
    fraction: Option<f64>,
) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "tray icon not initialized".to_string())?;
    let tooltip = match fraction {
        Some(f) => {
            let percent = (f.clamp(0.0, 1.0) * 100.0).round() as i64;
            format!("Uploading - {percent}%")
        }
        None => "Lopload".to_string(),
    };
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())
}

/// Set (or clear) the dock/taskbar badge count, used for the number of
/// currently-failed transfers (spec: failed state is sticky until
/// acknowledged, surfaced "in the window/dock badge").
///
/// On macOS and Linux (with a desktop file) this uses Tauri's native
/// `Window::set_badge_count`, which maps to the real dock/taskbar badge.
/// Windows has no equivalent API in Tauri 2 at time of writing, so there we
/// fall back to reflecting the count in the tray tooltip instead.
#[tauri::command]
pub fn set_badge_count<R: Runtime>(app: AppHandle<R>, count: Option<i64>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_badge_count(count).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let tooltip = match count {
                Some(n) if n > 0 => format!("Lopload - {n} failed"),
                _ => "Lopload".to_string(),
            };
            tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}
