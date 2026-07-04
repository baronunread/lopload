//! System tray icon + menu, and the small pieces of cross-platform "let the
//! user know what's happening without a window open" plumbing: tray tooltip
//! progress and the dock/taskbar failed-transfer badge.
//!
//! Per PLAN.md / spec: closing the main window hides it to the tray instead
//! of quitting, since transfers continue in the background. Only the tray's
//! "Quit Lopload" menu item actually exits the process.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime, WindowEvent,
};

const MENU_ID_SHOW: &str = "show";
const MENU_ID_QUIT: &str = "quit";

/// Build the tray icon + menu and wire up window-close-hides-to-tray
/// behavior. Call once from the `setup` hook.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, MENU_ID_SHOW, "Show Lopload", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_ID_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("bundle must configure a default window icon");

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .tooltip("Lopload")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_ID_SHOW => show_main_window(app),
            MENU_ID_QUIT => app.exit(0),
            _ => {}
        })
        .build(app)?;

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

/// Update the tray tooltip to reflect overall upload progress, e.g.
/// "Uploading — 42%". Pass `None` to clear it back to the plain app name.
///
/// Tauri 2's tray icon doesn't expose a numeric progress affordance on all
/// platforms (no taskbar progress API), so the tooltip is the portable
/// fallback used everywhere.
#[tauri::command]
pub fn tray_set_progress<R: Runtime>(app: AppHandle<R>, fraction: Option<f64>) -> Result<(), String> {
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "tray icon not initialized".to_string())?;
    let tooltip = match fraction {
        Some(f) => {
            let percent = (f.clamp(0.0, 1.0) * 100.0).round() as i64;
            format!("Uploading — {percent}%")
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
                Some(n) if n > 0 => format!("Lopload — {n} failed"),
                _ => "Lopload".to_string(),
            };
            tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}
