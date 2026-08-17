use gpui::{App, Global};
use lopload_native::transfer::{Transfer, TransferState};
use tray_icon::{
    Icon, TrayIcon, TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};

const SHOW: &str = "show";
const QUIT: &str = "quit";

pub enum TrayCommand {
    Show,
    Quit,
}

struct TrayState {
    icon: TrayIcon,
    status: MenuItem,
    normal_icon: Icon,
    failed_icon: Icon,
    showing_failed_icon: bool,
}

impl Global for TrayState {}

pub fn setup(cx: &mut App) -> Result<async_channel::Receiver<TrayCommand>, String> {
    let status = MenuItem::with_id("status", "Lopload is idle", false, None);
    let show = MenuItem::with_id(SHOW, "Show Lopload", true, None);
    let quit = MenuItem::with_id(QUIT, "Quit", true, None);
    let separator_top = PredefinedMenuItem::separator();
    let separator_bottom = PredefinedMenuItem::separator();
    let menu = Menu::with_items(&[&status, &separator_top, &show, &separator_bottom, &quit])
        .map_err(|error| error.to_string())?;

    let normal_icon = decode_icon(include_bytes!(
        "../../src-tauri/icons/tray-icon-template.png"
    ))?;
    let failed_icon = decode_icon(include_bytes!(
        "../../src-tauri/icons/tray-icon-template-failed.png"
    ))?;
    let icon = TrayIconBuilder::new()
        .with_id("lopload")
        .with_icon(normal_icon.clone())
        .with_icon_as_template(true)
        .with_tooltip("Lopload is idle")
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(true)
        .build()
        .map_err(|error| error.to_string())?;

    let (sender, receiver) = async_channel::unbounded();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let command = match event.id().0.as_str() {
            SHOW => Some(TrayCommand::Show),
            QUIT => Some(TrayCommand::Quit),
            _ => None,
        };
        if let Some(command) = command {
            let _ = sender.send_blocking(command);
        }
    }));

    cx.set_global(TrayState {
        icon,
        status,
        normal_icon,
        failed_icon,
        showing_failed_icon: false,
    });
    Ok(receiver)
}

pub fn update_status(transfers: &[Transfer], cx: &mut App) {
    if !cx.has_global::<TrayState>() {
        return;
    }
    let (label, failed) = status_line(transfers);
    let state = cx.global_mut::<TrayState>();
    state.status.set_text(&label);
    let _ = state.icon.set_tooltip(Some(&label));
    let show_failed_icon = failed > 0;
    if state.showing_failed_icon != show_failed_icon {
        let icon = if show_failed_icon {
            state.failed_icon.clone()
        } else {
            state.normal_icon.clone()
        };
        let _ = state.icon.set_icon(Some(icon));
        state.showing_failed_icon = show_failed_icon;
    }
}

fn status_line(transfers: &[Transfer]) -> (String, usize) {
    let active = transfers
        .iter()
        .filter(|transfer| {
            matches!(
                transfer.state,
                TransferState::Queued | TransferState::Sending { .. } | TransferState::Checking
            )
        })
        .collect::<Vec<_>>();
    let failed = transfers
        .iter()
        .filter(|transfer| matches!(transfer.state, TransferState::Failed { .. }))
        .count();
    if !active.is_empty() {
        let percent = active
            .iter()
            .map(|transfer| match transfer.state {
                TransferState::Queued => 0.0,
                TransferState::Sending { percent } => f64::from(percent),
                TransferState::Checking => 100.0,
                _ => 0.0,
            })
            .sum::<f64>()
            / active.len() as f64;
        let percent = percent.clamp(0.0, 100.0).round() as u64;
        let noun = if active.len() == 1 { "file" } else { "files" };
        (
            format!("Transferring {} {noun} - {percent}%", active.len()),
            failed,
        )
    } else if failed > 0 {
        let noun = if failed == 1 { "transfer" } else { "transfers" };
        (format!("{failed} {noun} failed"), failed)
    } else {
        ("Lopload is idle".into(), 0)
    }
}

fn decode_icon(bytes: &[u8]) -> Result<Icon, String> {
    let image = image_crate::load_from_memory(bytes)
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let (width, height) = image.dimensions();
    Icon::from_rgba(image.into_raw(), width, height).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopload_native::transfer::{ErrorClass, TransferDirection};

    fn transfer(state: TransferState) -> Transfer {
        Transfer {
            id: "transfer".into(),
            connection_id: "connection".into(),
            remote_key: "file.bin".into(),
            local_path: "/tmp/file.bin".into(),
            size: 1024,
            part_size: 1024,
            upload_id: None,
            direction: TransferDirection::Upload,
            state,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn summarizes_tray_transfer_status() {
        assert_eq!(status_line(&[]), ("Lopload is idle".into(), 0));
        assert_eq!(
            status_line(&[
                transfer(TransferState::Sending { percent: 25.0 }),
                transfer(TransferState::Checking),
            ]),
            ("Transferring 2 files - 63%".into(), 0)
        );
        assert_eq!(
            status_line(&[transfer(TransferState::Failed {
                error_class: ErrorClass::Offline,
            })]),
            ("1 transfer failed".into(), 1)
        );
    }
}
