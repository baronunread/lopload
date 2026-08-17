mod tray;

use chrono::{Local, TimeZone};
use gpui::{
    App, AppContext, Application, Bounds, ClipboardItem, Context, Entity, ExternalPaths,
    FontWeight, Image, ImageFormat, Render, Rgba, Subscription, Window, WindowAppearance,
    WindowBounds, WindowOptions, div, img, prelude::*, px, rgb, size,
};
use gpui_component::{
    Root,
    input::{Input, InputEvent, InputState},
    scroll::ScrollableElement,
};
use lopload_native::{
    NewStorageConnection, StorageConnection, UpdateStorageConnection, delete_connection,
    list_connections,
    operations::{
        TrashItem, delete_trash_item_with_progress, empty_trash_with_progress, files_in_folder,
        folder_info, list_folders, list_trash, move_entry_with_progress,
        move_to_trash_with_progress, rename_file, rename_folder, restore_trash_item_with_progress,
        share_link,
    },
    s3::{
        RemoteEntry, RemoteEntryKind, create_folder as create_remote_folder, list_entries,
        preview_bytes,
    },
    save_connection, set_last_prefix,
    settings::{
        ThemeMode, TransferTuning, auto_update_enabled, default_download_dir,
        set_auto_update_enabled, set_default_download_dir, set_theme_mode, set_transfer_tuning,
        theme_mode, transfer_tuning,
    },
    transfer::{
        ErrorClass, Transfer, TransferControl, TransferDirection, TransferState,
        abort_stale_uploads, dismiss_transfer, download_file, list_transfers, resume_download,
        resume_upload, upload_file,
    },
    update_connection,
};
use notify_rust::Notification;
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
    time::Instant,
};

static DARK_APPEARANCE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Screen {
    Home,
    AddStorage,
    Celebration,
    Browser,
    Trash,
    Settings,
}

enum BrowserStatus {
    Idle,
    Loading,
    Failed(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SortColumn {
    Name,
    Size,
    Modified,
}

enum TransferEvent {
    Update(Transfer, TransferControl),
    Removed(String),
    Status(String),
}

#[derive(Clone)]
struct DraggedEntries {
    entries: Vec<RemoteEntry>,
}

struct TransferSpeedSample {
    at: Instant,
    bytes: u64,
}

impl Render for DraggedEntries {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let label = if self.entries.len() == 1 {
            self.entries[0].name.clone()
        } else {
            format!("{} items", self.entries.len())
        };
        div()
            .rounded_lg()
            .bg(accent_color())
            .px_3()
            .py_2()
            .text_color(on_accent_color())
            .child(label)
    }
}

struct LoploadApp {
    screen: Screen,
    connections: Vec<StorageConnection>,
    current_connection: Option<StorageConnection>,
    prefix: String,
    entries: Vec<RemoteEntry>,
    previews: HashMap<String, std::sync::Arc<Image>>,
    preview_failures: HashSet<String>,
    browser_status: BrowserStatus,
    load_generation: u64,
    transfers: Vec<Transfer>,
    transfer_controls: HashMap<String, TransferControl>,
    transfer_speed_samples: HashMap<String, TransferSpeedSample>,
    transfer_speeds: HashMap<String, u64>,
    transfers_collapsed: bool,
    trash_items: Vec<TrashItem>,
    trash_loading: bool,
    pending_trash: Option<RemoteEntry>,
    pending_rename: Option<RemoteEntry>,
    pending_delete: Option<TrashItem>,
    confirm_empty_trash: bool,
    operation_status: Option<String>,
    info_entry: Option<RemoteEntry>,
    info_loading: bool,
    selected_keys: HashSet<String>,
    pending_bulk_trash: Vec<RemoteEntry>,
    pending_move: Vec<RemoteEntry>,
    move_destinations: Vec<String>,
    move_loading: bool,
    tuning: TransferTuning,
    theme_mode: Option<ThemeMode>,
    system_is_dark: bool,
    auto_update_enabled: bool,
    default_download_dir: Option<String>,
    settings_status: Option<String>,
    cleaning_stale_uploads: bool,
    sort_column: SortColumn,
    sort_descending: bool,
    name: Entity<InputState>,
    endpoint: Entity<InputState>,
    bucket: Entity<InputState>,
    region: Entity<InputState>,
    access_key: Entity<InputState>,
    secret_key: Entity<InputState>,
    folder_name: Entity<InputState>,
    rename_name: Entity<InputState>,
    filter: Entity<InputState>,
    form_error: Option<String>,
    editing_connection_id: Option<String>,
    connection_test_status: Option<String>,
    testing_connection: bool,
    folder_error: Option<String>,
    new_folder_open: bool,
    home_error: Option<String>,
    celebration_connection: Option<StorageConnection>,
    _subscriptions: Vec<Subscription>,
}

impl LoploadApp {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (connections, home_error) = match list_connections() {
            Ok(connections) => (connections, None),
            Err(_) => (
                Vec::new(),
                Some("Saved storage connections could not be loaded".to_string()),
            ),
        };
        let tuning = transfer_tuning().unwrap_or_default();
        let theme_mode = theme_mode().unwrap_or_default();
        let auto_update_enabled = auto_update_enabled().unwrap_or(true);
        let default_download_dir = default_download_dir().unwrap_or_default();
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter files"));
        let filter_subscription = cx.subscribe(&filter, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        let appearance_subscription = cx.observe_window_appearance(window, |this, window, cx| {
            this.system_is_dark = is_dark_appearance(window);
            set_dark_appearance(this.theme_mode, this.system_is_dark);
            cx.notify();
        });
        let system_is_dark = is_dark_appearance(window);
        set_dark_appearance(theme_mode, system_is_dark);
        let first_run = connections.is_empty();
        Self {
            screen: initial_screen(first_run),
            connections,
            current_connection: None,
            prefix: String::new(),
            entries: Vec::new(),
            previews: HashMap::new(),
            preview_failures: HashSet::new(),
            browser_status: BrowserStatus::Idle,
            load_generation: 0,
            transfers: Vec::new(),
            transfer_controls: HashMap::new(),
            transfer_speed_samples: HashMap::new(),
            transfer_speeds: HashMap::new(),
            transfers_collapsed: false,
            trash_items: Vec::new(),
            trash_loading: false,
            pending_trash: None,
            pending_rename: None,
            pending_delete: None,
            confirm_empty_trash: false,
            operation_status: None,
            info_entry: None,
            info_loading: false,
            selected_keys: HashSet::new(),
            pending_bulk_trash: Vec::new(),
            pending_move: Vec::new(),
            move_destinations: Vec::new(),
            move_loading: false,
            tuning,
            theme_mode,
            system_is_dark,
            auto_update_enabled,
            default_download_dir,
            settings_status: None,
            cleaning_stale_uploads: false,
            sort_column: SortColumn::Name,
            sort_descending: false,
            name: cx.new(|cx| InputState::new(window, cx).placeholder("My storage")),
            endpoint: cx
                .new(|cx| InputState::new(window, cx).placeholder("https://storage.example.com")),
            bucket: cx.new(|cx| InputState::new(window, cx).placeholder("Bucket name")),
            region: cx.new(|cx| InputState::new(window, cx).default_value("auto")),
            access_key: cx.new(|cx| InputState::new(window, cx).placeholder("Access key")),
            secret_key: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("Secret key")
                    .masked(true)
            }),
            folder_name: cx.new(|cx| InputState::new(window, cx).placeholder("Folder name")),
            rename_name: cx.new(|cx| InputState::new(window, cx).placeholder("New name")),
            filter,
            form_error: None,
            editing_connection_id: None,
            connection_test_status: None,
            testing_connection: false,
            folder_error: None,
            new_folder_open: false,
            home_error,
            celebration_connection: None,
            _subscriptions: vec![filter_subscription, appearance_subscription],
        }
    }

    fn open_connection(&mut self, connection: StorageConnection, cx: &mut Context<Self>) {
        let prefix = connection.last_prefix.clone();
        self.transfers = list_transfers(&connection.id).unwrap_or_default();
        self.transfer_controls.clear();
        self.transfer_speed_samples.clear();
        self.transfer_speeds.clear();
        tray::update_status(&self.transfers, cx);
        self.previews.clear();
        self.preview_failures.clear();
        self.current_connection = Some(connection);
        self.screen = Screen::Browser;
        self.load_prefix(prefix, cx);
        self.resume_pending_uploads(cx);
    }

    fn resume_pending_uploads(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        let pending = self
            .transfers
            .iter()
            .filter(|transfer| {
                matches!(transfer.direction, TransferDirection::Upload)
                    && transfer.upload_id.is_some()
                    && matches!(
                        transfer.state,
                        TransferState::Queued
                            | TransferState::Sending { .. }
                            | TransferState::Checking
                    )
            })
            .cloned()
            .collect::<Vec<_>>();
        for transfer in pending {
            self.start_resume_upload(connection.clone(), transfer, cx);
        }
    }

    fn start_resume_upload(
        &mut self,
        connection: StorageConnection,
        transfer: Transfer,
        cx: &mut Context<Self>,
    ) {
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        let control = TransferControl::default();
        let event_control = control.clone();
        cx.background_executor()
            .spawn(async move {
                let mut transfer_id = Some(transfer.id.clone());
                let result = resume_upload(&connection, transfer, &control, |updated| {
                    transfer_id = Some(updated.id.clone());
                    let _ =
                        sender.send_blocking(TransferEvent::Update(updated, event_control.clone()));
                });
                if control.is_cancelled() {
                    if let Some(id) = transfer_id {
                        let _ = sender.send_blocking(TransferEvent::Removed(id));
                    }
                } else {
                    notify_transfer_completion(
                        TransferDirection::Upload,
                        result.is_ok() as usize,
                        result.is_err() as usize,
                    );
                }
            })
            .detach();
    }

    fn start_resume_download(
        &mut self,
        connection: StorageConnection,
        transfer: Transfer,
        cx: &mut Context<Self>,
    ) {
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        let control = TransferControl::default();
        let event_control = control.clone();
        cx.background_executor()
            .spawn(async move {
                let id = transfer.id.clone();
                let result = resume_download(&connection, transfer, &control, |updated| {
                    let _ =
                        sender.send_blocking(TransferEvent::Update(updated, event_control.clone()));
                });
                if control.is_cancelled() {
                    let _ = sender.send_blocking(TransferEvent::Removed(id));
                } else {
                    notify_transfer_completion(
                        TransferDirection::Download,
                        result.is_ok() as usize,
                        result.is_err() as usize,
                    );
                }
            })
            .detach();
    }

    fn record_transfer(&mut self, transfer: Transfer, cx: &mut Context<Self>) {
        if let TransferState::Sending { percent } = &transfer.state {
            let bytes = (transfer.size as f64 * f64::from(*percent) / 100.0) as u64;
            let now = Instant::now();
            match self.transfer_speed_samples.get(&transfer.id) {
                Some(sample) if bytes > sample.bytes => {
                    let elapsed = now.duration_since(sample.at).as_secs_f64();
                    if elapsed >= 0.1 {
                        let speed = ((bytes - sample.bytes) as f64 / elapsed) as u64;
                        self.transfer_speeds.insert(transfer.id.clone(), speed);
                        self.transfer_speed_samples
                            .insert(transfer.id.clone(), TransferSpeedSample { at: now, bytes });
                    }
                }
                Some(sample) if bytes == sample.bytes => {}
                _ => {
                    self.transfer_speed_samples
                        .insert(transfer.id.clone(), TransferSpeedSample { at: now, bytes });
                    self.transfer_speeds.remove(&transfer.id);
                }
            }
        } else {
            self.transfer_speed_samples.remove(&transfer.id);
            self.transfer_speeds.remove(&transfer.id);
        }
        if let Some(saved) = self
            .transfers
            .iter_mut()
            .find(|saved| saved.id == transfer.id)
        {
            *saved = transfer.clone();
        } else {
            self.transfers.push(transfer.clone());
        }
        tray::update_status(&self.transfers, cx);
        if matches!(transfer.state, TransferState::Uploaded) {
            self.load_prefix(self.prefix.clone(), cx);
        } else {
            cx.notify();
        }
    }

    fn open_trash(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        self.screen = Screen::Trash;
        self.trash_loading = true;
        let load = cx
            .background_executor()
            .spawn(async move { list_trash(&connection) });
        cx.spawn(async move |this, cx| {
            let result = load.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.trash_loading = false;
                    match result {
                        Ok(items) => this.trash_items = items,
                        Err(error) => this.operation_status = Some(error),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn confirm_move_to_trash(&mut self, cx: &mut Context<Self>) {
        let (Some(connection), Some(entry)) =
            (self.current_connection.clone(), self.pending_trash.take())
        else {
            return;
        };
        self.operation_status = Some("Moving to Trash…".into());
        let key = entry.key.clone();
        let previous_entries = self.entries.clone();
        self.entries.retain(|saved| saved.key != key);
        let is_folder = matches!(entry.kind, RemoteEntryKind::Folder);
        let deleted_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        cx.notify();
        let operation = cx.background_executor().spawn(async move {
            move_to_trash_with_progress(&connection, &key, is_folder, deleted_at, |progress| {
                let _ = sender.send_blocking(TransferEvent::Status(format_operation_progress(
                    "Moving to Trash",
                    &progress,
                )));
            })
        });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        this.operation_status = Some("Moved to Trash".into());
                        this.load_prefix(this.prefix.clone(), cx);
                    }
                    Err(error) => {
                        this.entries = previous_entries;
                        this.operation_status = Some(error);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    fn submit_rename(&mut self, cx: &mut Context<Self>) {
        let (Some(connection), Some(entry)) =
            (self.current_connection.clone(), self.pending_rename.take())
        else {
            return;
        };
        let name = self.rename_name.read(cx).value().trim().to_string();
        if name.is_empty() || name.contains('/') {
            self.operation_status = Some("Enter a name without /".into());
            cx.notify();
            return;
        }
        let is_folder = matches!(entry.kind, RemoteEntryKind::Folder);
        let trimmed = entry.key.trim_end_matches('/');
        let parent = trimmed
            .rsplit_once('/')
            .map(|(parent, _)| format!("{parent}/"))
            .unwrap_or_default();
        let destination = format!("{parent}{name}{}", if is_folder { "/" } else { "" });
        if destination == entry.key {
            self.operation_status = Some("Choose a different name".into());
            cx.notify();
            return;
        }
        let previous_entries = self.entries.clone();
        if let Some(saved) = self.entries.iter_mut().find(|saved| saved.key == entry.key) {
            saved.key = destination.clone();
            saved.name = name;
        }
        self.operation_status = Some("Renaming…".into());
        cx.notify();
        let operation = cx.background_executor().spawn(async move {
            if is_folder {
                rename_folder(&connection, &entry.key, &destination)
            } else {
                rename_file(&connection, &entry.key, &destination)
            }
        });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        this.operation_status = Some("Renamed".into());
                        this.load_prefix(this.prefix.clone(), cx);
                    }
                    Err(error) => {
                        this.entries = previous_entries;
                        this.operation_status = Some(error);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    fn copy_share_link(&mut self, entry: RemoteEntry, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        self.operation_status = Some("Creating link…".into());
        let operation = cx
            .background_executor()
            .spawn(async move { share_link(&connection, &entry.key, 24 * 60 * 60) });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    match result {
                        Ok(link) => {
                            cx.write_to_clipboard(ClipboardItem::new_string(link));
                            this.operation_status = Some("Link copied — valid for 24 hours".into());
                        }
                        Err(error) => this.operation_status = Some(error),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn show_info(&mut self, mut entry: RemoteEntry, cx: &mut Context<Self>) {
        self.info_entry = Some(entry.clone());
        if !matches!(entry.kind, RemoteEntryKind::Folder) {
            cx.notify();
            return;
        }
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        self.info_loading = true;
        let prefix = entry.key.clone();
        let operation = cx
            .background_executor()
            .spawn(async move { folder_info(&connection, &prefix) });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.info_loading = false;
                    match result {
                        Ok((size, modified)) => {
                            entry.size = Some(size);
                            entry.last_modified = modified;
                            this.info_entry = Some(entry);
                        }
                        Err(error) => this.operation_status = Some(error),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn restore_from_trash(&mut self, item: TrashItem, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        self.operation_status = Some("Restoring…".into());
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        let operation = cx.background_executor().spawn(async move {
            restore_trash_item_with_progress(&connection, &item, |progress| {
                let _ = sender.send_blocking(TransferEvent::Status(format_operation_progress(
                    "Restoring",
                    &progress,
                )));
            })
        });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.operation_status = Some(match result {
                        Ok(()) => "Restored".into(),
                        Err(error) => error,
                    });
                    this.open_trash(cx);
                });
            }
        })
        .detach();
    }

    fn permanently_delete(&mut self, cx: &mut Context<Self>) {
        let (Some(connection), Some(item)) =
            (self.current_connection.clone(), self.pending_delete.take())
        else {
            return;
        };
        self.operation_status = Some("Deleting…".into());
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        let operation = cx.background_executor().spawn(async move {
            delete_trash_item_with_progress(&connection, &item, |progress| {
                let _ = sender.send_blocking(TransferEvent::Status(format_operation_progress(
                    "Deleting", &progress,
                )));
            })
        });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.operation_status = result.err();
                    this.open_trash(cx);
                });
            }
        })
        .detach();
    }

    fn permanently_empty_trash(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        self.confirm_empty_trash = false;
        self.operation_status = Some("Emptying Trash…".into());
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        let operation = cx.background_executor().spawn(async move {
            empty_trash_with_progress(&connection, |progress| {
                let _ = sender.send_blocking(TransferEvent::Status(format_operation_progress(
                    "Emptying Trash",
                    &progress,
                )));
            })
        });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.operation_status = result.err();
                    this.open_trash(cx);
                });
            }
        })
        .detach();
    }

    fn choose_download_folder(&mut self, cx: &mut Context<Self>) {
        let picker = cx
            .background_executor()
            .spawn(async move { rfd::FileDialog::new().pick_folder() });
        cx.spawn(async move |this, cx| {
            let folder = picker.await;
            if let (Some(this), Some(folder)) = (this.upgrade(), folder) {
                let _ = this.update(cx, |this, cx| {
                    let path = folder.to_string_lossy().to_string();
                    match set_default_download_dir(Some(&path)) {
                        Ok(()) => {
                            this.default_download_dir = Some(path);
                            this.settings_status = Some("Download folder saved".into());
                        }
                        Err(_) => this.settings_status = Some("Settings could not be saved".into()),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn choose_tuning(&mut self, preset: &str, cx: &mut Context<Self>) {
        let tuning = match preset {
            "slow" => TransferTuning {
                preset: "slow".into(),
                concurrent_files: 1,
                upload_parts_in_flight: 2,
                download_connections: 2,
                part_size_mib: 8,
            },
            "fast" => TransferTuning {
                preset: "fast".into(),
                concurrent_files: 4,
                upload_parts_in_flight: 8,
                download_connections: 8,
                part_size_mib: 8,
            },
            _ => TransferTuning::default(),
        };
        match set_transfer_tuning(&tuning) {
            Ok(()) => {
                self.tuning = tuning;
                self.settings_status = Some("Transfer settings saved".into());
            }
            Err(_) => self.settings_status = Some("Settings could not be saved".into()),
        }
        cx.notify();
    }

    fn clean_up_stale_uploads(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            self.settings_status = Some("Connect to a storage to run cleanup".into());
            cx.notify();
            return;
        };
        if self.cleaning_stale_uploads {
            return;
        }
        self.cleaning_stale_uploads = true;
        self.settings_status = Some("Cleaning up interrupted uploads…".into());
        cx.notify();
        let operation = cx
            .background_executor()
            .spawn(async move { abort_stale_uploads(&connection) });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.cleaning_stale_uploads = false;
                    this.settings_status = Some(match result {
                        Ok(stats) if stats.errors == 0 => format!(
                            "Cleaned up {} interrupted upload{}",
                            stats.aborted,
                            if stats.aborted == 1 { "" } else { "s" }
                        ),
                        Ok(stats) => format!(
                            "Cleaned up {} interrupted upload{}; {} could not be cleaned up",
                            stats.aborted,
                            if stats.aborted == 1 { "" } else { "s" },
                            stats.errors
                        ),
                        Err(_) => "Interrupted uploads could not be cleaned up".into(),
                    });
                    this.transfers = this
                        .current_connection
                        .as_ref()
                        .and_then(|connection| list_transfers(&connection.id).ok())
                        .unwrap_or_default();
                    tray::update_status(&this.transfers, cx);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn change_sort(&mut self, column: SortColumn, cx: &mut Context<Self>) {
        if self.sort_column == column {
            self.sort_descending = !self.sort_descending;
        } else {
            self.sort_column = column;
            self.sort_descending = false;
        }
        cx.notify();
    }

    fn listen_for_transfers(
        &mut self,
        receiver: async_channel::Receiver<TransferEvent>,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |this, cx| {
            while let Ok(event) = receiver.recv().await {
                if let Some(this) = this.upgrade() {
                    let _ = this.update(cx, |this, cx| match event {
                        TransferEvent::Update(transfer, control) => {
                            this.transfer_controls.insert(transfer.id.clone(), control);
                            this.record_transfer(transfer, cx);
                        }
                        TransferEvent::Removed(id) => {
                            this.transfers.retain(|transfer| transfer.id != id);
                            this.transfer_controls.remove(&id);
                            this.transfer_speed_samples.remove(&id);
                            this.transfer_speeds.remove(&id);
                            tray::update_status(&this.transfers, cx);
                            cx.notify();
                        }
                        TransferEvent::Status(status) => {
                            this.operation_status = Some(status);
                            cx.notify();
                        }
                    });
                }
            }
        })
        .detach();
    }

    fn start_upload(&mut self, cx: &mut Context<Self>) {
        let picker = cx
            .background_executor()
            .spawn(async move { rfd::FileDialog::new().pick_files() });
        cx.spawn(async move |this, cx| {
            let paths = picker.await;
            if let (Some(this), Some(paths)) = (this.upgrade(), paths) {
                let _ = this.update(cx, |this, cx| this.start_upload_paths(paths, cx));
            }
        })
        .detach();
    }

    fn start_upload_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        let prefix = self.prefix.clone();
        let concurrency = self.tuning.concurrent_files.max(1) as usize;
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        cx.background_executor()
            .spawn(async move {
                let files = expand_upload_paths(&paths);
                if files.len() != paths.len() {
                    let _ = sender.send_blocking(TransferEvent::Status(
                        "Folder drops aren't available in the native build yet".into(),
                    ));
                }
                let mut succeeded = 0;
                let mut failed = 0;
                for group in files.chunks(concurrency) {
                    let results = std::thread::scope(|scope| {
                        let mut handles = Vec::new();
                        for (path, relative_key) in group.iter().cloned() {
                            let connection = connection.clone();
                            let prefix = prefix.clone();
                            let sender = sender.clone();
                            handles.push(scope.spawn(move || {
                                let key = format!("{prefix}{relative_key}");
                                let control = TransferControl::default();
                                let event_control = control.clone();
                                let mut transfer_id = None;
                                let result =
                                    upload_file(&connection, &path, &key, &control, |transfer| {
                                        transfer_id = Some(transfer.id.clone());
                                        let _ = sender.send_blocking(TransferEvent::Update(
                                            transfer,
                                            event_control.clone(),
                                        ));
                                    });
                                if control.is_cancelled() {
                                    if let Some(id) = transfer_id {
                                        let _ = sender.send_blocking(TransferEvent::Removed(id));
                                    }
                                    None
                                } else {
                                    Some(result.is_ok())
                                }
                            }));
                        }
                        handles
                            .into_iter()
                            .map(|handle| handle.join().unwrap_or(None))
                            .collect::<Vec<_>>()
                    });
                    for result in results.into_iter().flatten() {
                        if result {
                            succeeded += 1;
                        } else {
                            failed += 1;
                        }
                    }
                }
                notify_transfer_completion(TransferDirection::Upload, succeeded, failed);
            })
            .detach();
    }

    fn start_download(&mut self, entry: RemoteEntry, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        let default_download_dir = self.default_download_dir.clone();
        cx.background_executor()
            .spawn(async move {
                let destination = if let Some(folder) = default_download_dir {
                    std::path::Path::new(&folder).join(&entry.name)
                } else {
                    let Some(destination) = rfd::FileDialog::new()
                        .set_file_name(&entry.name)
                        .save_file()
                    else {
                        return;
                    };
                    destination
                };
                let control = TransferControl::default();
                let event_control = control.clone();
                let mut transfer_id = None;
                let result = download_file(
                    &connection,
                    &entry.key,
                    &destination,
                    entry.size.unwrap_or_default(),
                    &control,
                    |transfer| {
                        transfer_id = Some(transfer.id.clone());
                        let _ = sender
                            .send_blocking(TransferEvent::Update(transfer, event_control.clone()));
                    },
                );
                if control.is_cancelled() {
                    if let Some(id) = transfer_id {
                        let _ = sender.send_blocking(TransferEvent::Removed(id));
                    }
                } else {
                    notify_transfer_completion(
                        TransferDirection::Download,
                        result.is_ok() as usize,
                        result.is_err() as usize,
                    );
                }
            })
            .detach();
    }

    fn toggle_selection(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.selected_keys.remove(key) {
            self.selected_keys.insert(key.to_string());
        }
        cx.notify();
    }

    fn selected_entries(&self) -> Vec<RemoteEntry> {
        self.entries
            .iter()
            .filter(|entry| self.selected_keys.contains(&entry.key))
            .cloned()
            .collect()
    }

    fn prepare_bulk_trash(&mut self, cx: &mut Context<Self>) {
        self.pending_bulk_trash = self.selected_entries();
        cx.notify();
    }

    fn confirm_bulk_trash(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        let entries = std::mem::take(&mut self.pending_bulk_trash);
        if entries.is_empty() {
            return;
        }
        let previous_entries = self.entries.clone();
        let removing = entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect::<HashSet<_>>();
        self.entries
            .retain(|entry| !removing.contains(entry.key.as_str()));
        drop(removing);
        self.operation_status = Some("Moving selected items to Trash…".into());
        let deleted_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        cx.notify();
        let operation = cx.background_executor().spawn(async move {
            for entry in entries {
                move_to_trash_with_progress(
                    &connection,
                    &entry.key,
                    matches!(entry.kind, RemoteEntryKind::Folder),
                    deleted_at,
                    |progress| {
                        let _ = sender.send_blocking(TransferEvent::Status(
                            format_operation_progress("Moving to Trash", &progress),
                        ));
                    },
                )?;
            }
            Ok::<_, String>(())
        });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        this.selected_keys.clear();
                        this.operation_status = Some("Moved selected items to Trash".into());
                        this.load_prefix(this.prefix.clone(), cx);
                    }
                    Err(error) => {
                        this.entries = previous_entries;
                        this.operation_status = Some(error);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    fn prepare_move(&mut self, entries: Vec<RemoteEntry>, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        if entries.is_empty() {
            return;
        }
        self.pending_move = entries;
        self.move_destinations.clear();
        self.move_loading = true;
        let operation = cx
            .background_executor()
            .spawn(async move { list_folders(&connection) });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.move_loading = false;
                    match result {
                        Ok(folders) => {
                            this.move_destinations = folders
                                .into_iter()
                                .filter(|folder| {
                                    this.pending_move.iter().all(|entry| {
                                        parent_of_key(&entry.key) != *folder
                                            && (!matches!(entry.kind, RemoteEntryKind::Folder)
                                                || !folder.starts_with(&entry.key))
                                    })
                                })
                                .collect();
                        }
                        Err(error) => this.operation_status = Some(error),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn confirm_move(&mut self, destination: String, cx: &mut Context<Self>) {
        let entries = std::mem::take(&mut self.pending_move);
        self.move_destinations.clear();
        self.start_move(entries, destination, cx);
    }

    fn start_move(
        &mut self,
        entries: Vec<RemoteEntry>,
        destination: String,
        cx: &mut Context<Self>,
    ) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        if entries.is_empty() {
            return;
        }
        let previous_entries = self.entries.clone();
        let moving = entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect::<HashSet<_>>();
        self.entries
            .retain(|entry| !moving.contains(entry.key.as_str()));
        drop(moving);
        self.operation_status = Some("Moving…".into());
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        cx.notify();
        let operation = cx.background_executor().spawn(async move {
            for entry in entries {
                move_entry_with_progress(
                    &connection,
                    &entry.key,
                    matches!(entry.kind, RemoteEntryKind::Folder),
                    &destination,
                    |progress| {
                        let detail = format_operation_progress("Moving", &progress);
                        let _ = sender.send_blocking(TransferEvent::Status(detail));
                    },
                )?;
            }
            Ok::<_, String>(())
        });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        this.selected_keys.clear();
                        this.operation_status = Some("Moved".into());
                        this.load_prefix(this.prefix.clone(), cx);
                    }
                    Err(error) => {
                        this.entries = previous_entries;
                        this.operation_status = Some(error);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    fn start_bulk_download(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        let entries = self.selected_entries();
        if entries.is_empty() {
            return;
        }
        let default_download_dir = self.default_download_dir.clone();
        let concurrency = self.tuning.concurrent_files.max(1) as usize;
        let (sender, receiver) = async_channel::unbounded();
        self.listen_for_transfers(receiver, cx);
        cx.background_executor()
            .spawn(async move {
                let root = if let Some(folder) = default_download_dir {
                    PathBuf::from(folder)
                } else {
                    let Some(folder) = rfd::FileDialog::new().pick_folder() else {
                        return;
                    };
                    folder
                };
                let mut downloads = Vec::new();
                let mut skipped = 0;
                for entry in entries {
                    if matches!(entry.kind, RemoteEntryKind::File) {
                        if let Some(destination) = safe_destination(&root, &entry.name) {
                            downloads.push((
                                entry.key,
                                entry.size.unwrap_or_default(),
                                destination,
                            ));
                        } else {
                            skipped += 1;
                        }
                        continue;
                    }
                    let folder_name = entry.name.clone();
                    match files_in_folder(&connection, &entry.key) {
                        Ok(files) => {
                            for file in files {
                                let suffix = file.key.strip_prefix(&entry.key).unwrap_or(&file.key);
                                let relative = format!("{folder_name}/{suffix}");
                                if let Some(destination) = safe_destination(&root, &relative) {
                                    downloads.push((file.key, file.size, destination));
                                } else {
                                    skipped += 1;
                                }
                            }
                        }
                        Err(error) => {
                            let _ = sender.send_blocking(TransferEvent::Status(error));
                            return;
                        }
                    }
                }
                if skipped > 0 {
                    let _ = sender.send_blocking(TransferEvent::Status(format!(
                        "Skipped {skipped} unsafe file names"
                    )));
                }
                let mut succeeded = 0;
                let mut failed = 0;
                for group in downloads.chunks(concurrency) {
                    let results = std::thread::scope(|scope| {
                        let mut handles = Vec::new();
                        for (key, size, destination) in group.iter().cloned() {
                            let connection = connection.clone();
                            let sender = sender.clone();
                            handles.push(scope.spawn(move || {
                                let control = TransferControl::default();
                                let event_control = control.clone();
                                let mut transfer_id = None;
                                let result = download_file(
                                    &connection,
                                    &key,
                                    &destination,
                                    size,
                                    &control,
                                    |transfer| {
                                        transfer_id = Some(transfer.id.clone());
                                        let _ = sender.send_blocking(TransferEvent::Update(
                                            transfer,
                                            event_control.clone(),
                                        ));
                                    },
                                );
                                if control.is_cancelled() {
                                    if let Some(id) = transfer_id {
                                        let _ = sender.send_blocking(TransferEvent::Removed(id));
                                    }
                                    None
                                } else {
                                    Some(result.is_ok())
                                }
                            }));
                        }
                        handles
                            .into_iter()
                            .map(|handle| handle.join().unwrap_or(None))
                            .collect::<Vec<_>>()
                    });
                    for result in results.into_iter().flatten() {
                        if result {
                            succeeded += 1;
                        } else {
                            failed += 1;
                        }
                    }
                }
                notify_transfer_completion(TransferDirection::Download, succeeded, failed);
            })
            .detach();
    }

    fn begin_add_connection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.editing_connection_id = None;
        self.form_error = None;
        self.connection_test_status = None;
        for input in [
            &self.name,
            &self.endpoint,
            &self.bucket,
            &self.access_key,
            &self.secret_key,
        ] {
            input.update(cx, |input, cx| input.set_value("", window, cx));
        }
        self.region
            .update(cx, |input, cx| input.set_value("auto", window, cx));
        self.screen = Screen::AddStorage;
        cx.notify();
    }

    fn begin_edit_connection(
        &mut self,
        connection: StorageConnection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.editing_connection_id = Some(connection.id);
        self.form_error = None;
        self.connection_test_status = None;
        for (input, value) in [
            (&self.name, connection.name),
            (&self.endpoint, connection.endpoint),
            (&self.bucket, connection.bucket),
            (&self.region, connection.region),
            (&self.access_key, String::new()),
            (&self.secret_key, String::new()),
        ] {
            input.update(cx, |input, cx| input.set_value(value, window, cx));
        }
        self.screen = Screen::AddStorage;
        cx.notify();
    }

    fn test_connection_form(&mut self, cx: &mut Context<Self>) {
        let endpoint = self.endpoint.read(cx).value().to_string();
        let bucket = self.bucket.read(cx).value().to_string();
        let region = self.region.read(cx).value().to_string();
        let access_key = self.access_key.read(cx).value().to_string();
        let secret_key = self.secret_key.read(cx).value().to_string();
        let saved_connection = self.editing_connection_id.as_ref().and_then(|id| {
            self.connections
                .iter()
                .find(|connection| &connection.id == id)
                .cloned()
        });
        self.testing_connection = true;
        self.connection_test_status = Some("Testing connection…".into());
        cx.notify();
        let test = cx.background_executor().spawn(async move {
            if access_key.is_empty() && secret_key.is_empty() {
                if let Some(mut connection) = saved_connection {
                    connection.endpoint = endpoint;
                    connection.bucket = bucket;
                    connection.region = region;
                    lopload_native::s3::test_connection(&connection)
                } else {
                    Err("Enter both credential fields before testing".into())
                }
            } else {
                lopload_native::s3::test_connection_details(
                    &endpoint,
                    &bucket,
                    &region,
                    &access_key,
                    &secret_key,
                )
            }
        });
        cx.spawn(async move |this, cx| {
            let result = test.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    this.testing_connection = false;
                    this.connection_test_status = Some(match result {
                        Ok(()) => "Connection successful".into(),
                        Err(error) => error,
                    });
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn load_prefix(&mut self, prefix: String, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        if self.prefix != prefix {
            self.selected_keys.clear();
        }
        self.prefix = prefix.clone();
        self.browser_status = BrowserStatus::Loading;
        self.load_generation += 1;
        let generation = self.load_generation;
        cx.notify();

        let load = cx
            .background_executor()
            .spawn(async move { list_entries(&connection, &prefix) });
        cx.spawn(async move |this, cx| {
            let result = load.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    if this.load_generation != generation {
                        return;
                    }
                    match result {
                        Ok(entries) => {
                            let preview_entries = entries.clone();
                            this.selected_keys
                                .retain(|key| entries.iter().any(|entry| &entry.key == key));
                            this.entries = entries;
                            this.browser_status = BrowserStatus::Idle;
                            if let Some(connection) = this.current_connection.as_mut() {
                                connection.last_prefix = this.prefix.clone();
                                let _ = set_last_prefix(&connection.id, &this.prefix);
                                if let Some(saved) = this
                                    .connections
                                    .iter_mut()
                                    .find(|saved| saved.id == connection.id)
                                {
                                    saved.last_prefix = this.prefix.clone();
                                }
                            }
                            this.load_previews(preview_entries, generation, cx);
                        }
                        Err(error) => this.browser_status = BrowserStatus::Failed(error),
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn load_previews(
        &mut self,
        entries: Vec<RemoteEntry>,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        const MAXIMUM_PREVIEW_SIZE: u64 = 25 * 1024 * 1024;
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        let candidates = entries
            .into_iter()
            .filter_map(|entry| {
                let format = image_format(&entry.name)?;
                if entry.size.unwrap_or(MAXIMUM_PREVIEW_SIZE + 1) > MAXIMUM_PREVIEW_SIZE
                    || self.previews.contains_key(&entry.key)
                    || self.preview_failures.contains(&entry.key)
                {
                    return None;
                }
                Some((entry.key, format))
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return;
        }
        let load = cx.background_executor().spawn(async move {
            candidates
                .into_iter()
                .map(|(key, format)| {
                    let result = preview_bytes(&connection, &key, MAXIMUM_PREVIEW_SIZE)
                        .map(|bytes| std::sync::Arc::new(Image::from_bytes(format, bytes)));
                    (key, result)
                })
                .collect::<Vec<_>>()
        });
        cx.spawn(async move |this, cx| {
            let previews = load.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| {
                    if this.load_generation != generation {
                        return;
                    }
                    for (key, preview) in previews {
                        match preview {
                            Ok(preview) => {
                                this.previews.insert(key, preview);
                            }
                            Err(_) => {
                                this.preview_failures.insert(key);
                            }
                        }
                    }
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn parent_prefix(&self) -> String {
        let trimmed = self.prefix.trim_end_matches('/');
        match trimmed.rfind('/') {
            Some(index) => trimmed[..=index].to_string(),
            None => String::new(),
        }
    }

    fn submit_folder(&mut self, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        let prefix = self.prefix.clone();
        let name = self.folder_name.read(cx).value().trim().to_string();
        self.folder_error = None;
        if name.is_empty() {
            self.folder_error = Some("Enter a folder name".into());
            cx.notify();
            return;
        }
        if name.contains('/') {
            self.folder_error = Some("Folder names cannot contain /".into());
            cx.notify();
            return;
        }
        let previous_entries = self.entries.clone();
        let key = format!("{prefix}{name}/");
        if !self.entries.iter().any(|entry| entry.key == key) {
            self.entries.push(RemoteEntry {
                kind: RemoteEntryKind::Folder,
                name: name.clone(),
                key,
                size: None,
                last_modified: None,
            });
        }
        self.new_folder_open = false;
        self.operation_status = Some("Creating folder…".into());
        cx.notify();
        let create = cx
            .background_executor()
            .spawn(async move { create_remote_folder(&connection, &prefix, &name) });
        cx.spawn(async move |this, cx| {
            let result = create.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        this.operation_status = Some("Folder created".into());
                        this.load_prefix(this.prefix.clone(), cx);
                    }
                    Err(error) => {
                        this.entries = previous_entries;
                        this.new_folder_open = true;
                        this.folder_error = Some(error);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    fn render_home(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let connections = self.connections.clone();
        div().flex_1().flex().justify_center().p_6().child(
            div()
                .flex()
                .flex_col()
                .gap_4()
                .w(px(620.0))
                .child(
                    div()
                        .pt_8()
                        .text_2xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("Your storage"),
                )
                .child(
                    div()
                        .text_color(subtle_color())
                        .child("Choose a connection or add another one."),
                )
                .when_some(self.home_error.clone(), |panel, error| {
                    panel.child(div().text_sm().text_color(danger_color()).child(error))
                })
                .children(
                    connections
                        .into_iter()
                        .enumerate()
                        .map(|(index, connection)| {
                            let selected = connection.clone();
                            let edited = connection.clone();
                            div()
                                .id(("connection", index))
                                .flex()
                                .items_center()
                                .justify_between()
                                .rounded_xl()
                                .border_1()
                                .border_color(border_color())
                                .bg(surface_color())
                                .p_4()
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap_1()
                                        .child(
                                            div()
                                                .id(("edit-connection", index))
                                                .cursor_pointer()
                                                .rounded_lg()
                                                .border_1()
                                                .border_color(strong_border_color())
                                                .px_3()
                                                .py_2()
                                                .child("Edit")
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.begin_edit_connection(
                                                            edited.clone(),
                                                            window,
                                                            cx,
                                                        );
                                                    },
                                                )),
                                        )
                                        .child(
                                            div()
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child(connection.name),
                                        )
                                        .child(
                                            div()
                                                .text_sm()
                                                .text_color(subtle_color())
                                                .child(connection.bucket),
                                        ),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .gap_2()
                                        .child(
                                            div()
                                                .id(("open-connection", index))
                                                .cursor_pointer()
                                                .rounded_lg()
                                                .bg(tint_color())
                                                .px_3()
                                                .py_2()
                                                .child("Open")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_connection(selected.clone(), cx);
                                                })),
                                        )
                                        .child(
                                            div()
                                                .id(("delete-connection", index))
                                                .cursor_pointer()
                                                .rounded_lg()
                                                .border_1()
                                                .border_color(danger_border_color())
                                                .px_3()
                                                .py_2()
                                                .text_color(danger_color())
                                                .child("Remove")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    match delete_connection(&connection.id) {
                                                        Ok(()) => {
                                                            this.connections.retain(|saved| {
                                                                saved.id != connection.id
                                                            })
                                                        }
                                                        Err(_) => {
                                                            this.home_error = Some(
                                                                "This storage could not be removed"
                                                                    .to_string(),
                                                            )
                                                        }
                                                    }
                                                    cx.notify();
                                                })),
                                        ),
                                )
                        }),
                )
                .child(
                    div()
                        .id("add-storage")
                        .cursor_pointer()
                        .rounded_lg()
                        .bg(accent_color())
                        .px_4()
                        .py_2()
                        .text_color(on_accent_color())
                        .child("Add storage")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.begin_add_connection(window, cx);
                        })),
                ),
        )
    }

    fn render_celebration(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let connection = self.celebration_connection.clone();
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .p_6()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_4()
                    .w(px(560.0))
                    .rounded_xl()
                    .border_1()
                    .border_color(border_color())
                    .bg(surface_color())
                    .p_8()
                    .child(div().text_2xl().child("✨"))
                    .child(
                        div()
                            .text_2xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Your storage is ready"),
                    )
                    .child(
                        div()
                            .text_color(subtle_color())
                            .text_center()
                            .child("You can upload, organize, and download files now."),
                    )
                    .child(
                        div()
                            .id("start-browsing")
                            .cursor_pointer()
                            .rounded_lg()
                            .bg(accent_color())
                            .px_5()
                            .py_2()
                            .text_color(on_accent_color())
                            .child("Start browsing")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(connection) = connection.clone() {
                                    this.celebration_connection = None;
                                    this.open_connection(connection, cx);
                                }
                            })),
                    ),
            )
    }

    fn render_add_storage(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let editing = self.editing_connection_id.is_some();
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .p_6()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_4()
                    .w(px(560.0))
                    .p_8()
                    .rounded_xl()
                    .border_1()
                    .border_color(border_color())
                    .bg(surface_color())
                    .shadow_lg()
                    .child(
                        div()
                            .text_2xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(if editing { "Edit storage" } else { "Add storage" }),
                    )
                    .child(
                        div()
                            .text_color(subtle_color())
                            .child(if editing {
                                "Leave both credential fields blank to keep the credentials already in your OS keychain."
                            } else {
                                "Connection details stay in the app database. Credentials go directly to your OS keychain."
                            }),
                    )
                    .child(field("Name", Input::new(&self.name).w_full()))
                    .child(field("Endpoint", Input::new(&self.endpoint).w_full()))
                    .child(
                        div()
                            .flex()
                            .gap_3()
                            .child(
                                div()
                                    .flex_1()
                                    .child(field("Bucket", Input::new(&self.bucket).w_full())),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .child(field("Region", Input::new(&self.region).w_full())),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_3()
                            .child(
                                div()
                                    .flex_1()
                                    .child(field("Access key", Input::new(&self.access_key).w_full())),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .child(field("Secret key", Input::new(&self.secret_key).w_full())),
                            ),
                    )
                    .when_some(self.form_error.clone(), |panel, error| {
                        panel.child(div().text_sm().text_color(danger_color()).child(error))
                    })
                    .when_some(self.connection_test_status.clone(), |panel, status| {
                        panel.child(div().text_sm().text_color(accent_color()).child(status))
                    })
                    .child(
                        div()
                            .flex()
                            .gap_3()
                            .child(
                                div()
                                    .id("back")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_4()
                                    .py_2()
                                    .child("Back")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.screen = Screen::Home;
                                        this.form_error = None;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                div()
                                    .id("test-storage")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_4()
                                    .py_2()
                                    .child(if self.testing_connection {
                                        "Testing…"
                                    } else {
                                        "Test connection"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if !this.testing_connection {
                                            this.test_connection_form(cx);
                                        }
                                    })),
                            )
                            .child(
                                div()
                                    .id("save-storage")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .bg(accent_color())
                                    .px_4()
                                    .py_2()
                                    .text_color(on_accent_color())
                                    .child("Save storage")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        let name = this.name.read(cx).value().to_string();
                                        let endpoint = this.endpoint.read(cx).value().to_string();
                                        let bucket = this.bucket.read(cx).value().to_string();
                                        let region = this.region.read(cx).value().to_string();
                                        let access_key = this.access_key.read(cx).value().to_string();
                                        let secret_key = this.secret_key.read(cx).value().to_string();
                                        let first_connection = this.editing_connection_id.is_none()
                                            && this.connections.is_empty();
                                        let result = if let Some(id) = this.editing_connection_id.clone() {
                                            let keep_credentials = access_key.is_empty() && secret_key.is_empty();
                                            update_connection(UpdateStorageConnection {
                                                id,
                                                name,
                                                endpoint,
                                                bucket,
                                                region,
                                                access_key: (!keep_credentials).then_some(access_key),
                                                secret_key: (!keep_credentials).then_some(secret_key),
                                            })
                                        } else {
                                            save_connection(NewStorageConnection {
                                                name,
                                                endpoint,
                                                bucket,
                                                region,
                                                access_key,
                                                secret_key,
                                            })
                                        };
                                        match result {
                                            Ok(connection) => {
                                                if let Some(saved) = this
                                                    .connections
                                                    .iter_mut()
                                                    .find(|saved| saved.id == connection.id)
                                                {
                                                    *saved = connection.clone();
                                                } else {
                                                    this.connections.push(connection.clone());
                                                }
                                                this.form_error = None;
                                                this.editing_connection_id = None;
                                                this.access_key.update(cx, |input, cx| {
                                                    input.set_value("", window, cx)
                                                });
                                                this.secret_key.update(cx, |input, cx| {
                                                    input.set_value("", window, cx)
                                                });
                                                if first_connection {
                                                    this.celebration_connection = Some(connection);
                                                }
                                                this.screen = screen_after_connection_save(first_connection);
                                            }
                                            Err(error) => this.form_error = Some(error),
                                        }
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
    }

    fn render_browser(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let connection_name = self
            .current_connection
            .as_ref()
            .map(|connection| connection.name.clone())
            .unwrap_or_default();
        let prefix = self.prefix.clone();
        let parent = self.parent_prefix();
        let query = self.filter.read(cx).value().trim().to_lowercase();
        let mut entries = self
            .entries
            .iter()
            .filter(|entry| query.is_empty() || entry.name.to_lowercase().contains(&query))
            .cloned()
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            let folder_order = matches!(right.kind, RemoteEntryKind::Folder)
                .cmp(&matches!(left.kind, RemoteEntryKind::Folder));
            if !folder_order.is_eq() {
                return folder_order;
            }
            let order = match self.sort_column {
                SortColumn::Name => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
                SortColumn::Size => left
                    .size
                    .unwrap_or_default()
                    .cmp(&right.size.unwrap_or_default()),
                SortColumn::Modified => left
                    .last_modified
                    .unwrap_or_default()
                    .cmp(&right.last_modified.unwrap_or_default()),
            };
            if self.sort_descending {
                order.reverse()
            } else {
                order
            }
        });
        let transfers = self.transfers.clone();
        let transfer_summary = transfer_summary(&transfers);
        let transfer_speeds = self.transfer_speeds.clone();
        let transfers_collapsed = self.transfers_collapsed;
        let current_connection = self.current_connection.clone();
        let selected_count = self.selected_keys.len();
        let pending_bulk_count = self.pending_bulk_trash.len();
        let pending_move_count = self.pending_move.len();
        let move_destinations = self.move_destinations.clone();
        let pending_trash = self.pending_trash.clone();
        let pending_rename = self.pending_rename.clone();
        let operation_status = self.operation_status.clone();
        let info_entry = self.info_entry.clone();
        let status = browser_status_message(
            &self.browser_status,
            self.entries.len(),
            entries.len(),
            !query.is_empty(),
        );
        let credential_error = matches!(
            &self.browser_status,
            BrowserStatus::Failed(error) if error.to_lowercase().contains("credential")
        );

        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_h_0()
            .drag_over::<ExternalPaths>(|style, _, _, _| style.bg(tint_color()))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                this.start_upload_paths(paths.paths().to_vec(), cx);
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_6()
                    .py_4()
                    .border_b_1()
                    .border_color(border_color())
                    .child(
                        div()
                            .id("all-storage")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(strong_border_color())
                            .px_3()
                            .py_2()
                            .child("All storage")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.screen = Screen::Home;
                                this.load_generation += 1;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("open-trash")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(strong_border_color())
                            .px_3()
                            .py_2()
                            .child("Trash")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.operation_status = None;
                                this.open_trash(cx);
                            })),
                    )
                    .when(!prefix.is_empty(), |toolbar| {
                        let navigate_parent = parent.clone();
                        let drop_parent = parent.clone();
                        let allowed_parent = parent.clone();
                        toolbar.child(
                            div()
                                .id("up")
                                .cursor_pointer()
                                .rounded_lg()
                                .border_1()
                                .border_color(strong_border_color())
                                .px_3()
                                .py_2()
                                .child("Up")
                                .can_drop(move |value, _, _| {
                                    value.downcast_ref::<DraggedEntries>().is_some_and(|drag| {
                                        can_move_entries_to(&drag.entries, &allowed_parent)
                                    })
                                })
                                .drag_over::<DraggedEntries>(|style, _, _, _| {
                                    style.bg(strong_tint_color()).border_color(accent_color())
                                })
                                .on_drop(cx.listener(move |this, drag: &DraggedEntries, _, cx| {
                                    cx.stop_propagation();
                                    this.start_move(drag.entries.clone(), drop_parent.clone(), cx);
                                }))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.load_prefix(navigate_parent.clone(), cx);
                                })),
                        )
                    })
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(connection_name),
                            )
                            .child(div().text_sm().text_color(subtle_color()).child(
                                if prefix.is_empty() {
                                    "Home".to_string()
                                } else {
                                    format!("Home / {}", prefix.trim_end_matches('/'))
                                },
                            )),
                    )
                    .child(Input::new(&self.filter).w(px(180.0)))
                    .when(selected_count > 0, |toolbar| {
                        toolbar
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(format!("{selected_count} selected")),
                            )
                            .child(
                                div()
                                    .id("bulk-download")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_2()
                                    .child("Download")
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.start_bulk_download(cx)),
                                    ),
                            )
                            .child(
                                div()
                                    .id("bulk-move")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_2()
                                    .child("Move")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.prepare_move(this.selected_entries(), cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("bulk-trash")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(danger_border_color())
                                    .px_3()
                                    .py_2()
                                    .text_color(danger_color())
                                    .child("Trash")
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.prepare_bulk_trash(cx)),
                                    ),
                            )
                            .child(
                                div()
                                    .id("clear-selection")
                                    .cursor_pointer()
                                    .px_3()
                                    .py_2()
                                    .child("Clear")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.selected_keys.clear();
                                        cx.notify();
                                    })),
                            )
                    })
                    .child(
                        div()
                            .id("upload-files")
                            .cursor_pointer()
                            .rounded_lg()
                            .bg(accent_color())
                            .px_3()
                            .py_2()
                            .text_color(on_accent_color())
                            .child("Upload files")
                            .on_click(cx.listener(|this, _, _, cx| this.start_upload(cx))),
                    )
                    .child(
                        div()
                            .id("new-folder")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(strong_border_color())
                            .px_3()
                            .py_2()
                            .child("New folder")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.new_folder_open = !this.new_folder_open;
                                this.folder_error = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("refresh")
                            .cursor_pointer()
                            .rounded_lg()
                            .bg(tint_color())
                            .px_3()
                            .py_2()
                            .child("Refresh")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.load_prefix(prefix.clone(), cx);
                            })),
                    ),
            )
            .when_some(operation_status, |browser, status| {
                browser.child(
                    div()
                        .px_6()
                        .py_2()
                        .bg(warning_surface_color())
                        .text_color(warning_text_color())
                        .child(status),
                )
            })
            .when_some(info_entry, |browser, entry| {
                browser.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_4()
                        .px_6()
                        .py_4()
                        .border_b_1()
                        .border_color(border_color())
                        .bg(surface_color())
                        .child(
                            div()
                                .flex_1()
                                .child(div().font_weight(FontWeight::SEMIBOLD).child(entry.name))
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(subtle_color())
                                        .child(format!("Location: Home / {}", entry.key)),
                                ),
                        )
                        .child(div().text_sm().child(if self.info_loading {
                            "Calculating…".into()
                        } else {
                            entry.size.map(format_bytes).unwrap_or_else(|| "—".into())
                        }))
                        .child(
                            div().text_sm().child(
                                entry
                                    .last_modified
                                    .map(format_date)
                                    .unwrap_or_else(|| "—".into()),
                            ),
                        )
                        .child(
                            div()
                                .id("close-info")
                                .cursor_pointer()
                                .rounded_lg()
                                .border_1()
                                .border_color(strong_border_color())
                                .px_3()
                                .py_2()
                                .child("Close")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.info_entry = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .when(pending_bulk_count > 0, |browser| {
                browser.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .px_6()
                        .py_4()
                        .border_b_1()
                        .border_color(danger_border_color())
                        .bg(danger_surface_color())
                        .child(div().flex_1().child(format!(
                            "Move {pending_bulk_count} selected items to Trash?"
                        )))
                        .child(
                            div()
                                .id("cancel-bulk-trash")
                                .cursor_pointer()
                                .px_3()
                                .py_2()
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.pending_bulk_trash.clear();
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("confirm-bulk-trash")
                                .cursor_pointer()
                                .rounded_lg()
                                .bg(danger_color())
                                .px_3()
                                .py_2()
                                .text_color(on_accent_color())
                                .child("Move to Trash")
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.confirm_bulk_trash(cx)),
                                ),
                        ),
                )
            })
            .when(pending_move_count > 0, |browser| {
                browser.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_3()
                        .px_6()
                        .py_4()
                        .border_b_1()
                        .border_color(border_color())
                        .bg(surface_color())
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .child(
                                    div()
                                        .flex_1()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(format!("Move {pending_move_count} item(s) to…")),
                                )
                                .child(
                                    div()
                                        .id("cancel-move")
                                        .cursor_pointer()
                                        .px_3()
                                        .py_2()
                                        .child("Cancel")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.pending_move.clear();
                                            this.move_destinations.clear();
                                            cx.notify();
                                        })),
                                ),
                        )
                        .when(self.move_loading, |panel| panel.child("Loading folders…"))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .max_h(px(220.0))
                                .overflow_y_scrollbar()
                                .children(move_destinations.into_iter().enumerate().map(
                                    |(index, destination)| {
                                        let selected_destination = destination.clone();
                                        div()
                                            .id(("move-destination", index))
                                            .cursor_pointer()
                                            .rounded_lg()
                                            .bg(tint_color())
                                            .px_3()
                                            .py_2()
                                            .child(if destination.is_empty() {
                                                "Home".to_string()
                                            } else {
                                                format!(
                                                    "Home / {}",
                                                    destination.trim_end_matches('/')
                                                )
                                            })
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.confirm_move(selected_destination.clone(), cx)
                                            }))
                                    },
                                )),
                        ),
                )
            })
            .when_some(pending_trash, |browser, entry| {
                browser.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .px_6()
                        .py_4()
                        .border_b_1()
                        .border_color(danger_border_color())
                        .bg(danger_surface_color())
                        .child(
                            div()
                                .flex_1()
                                .child(format!("Move {} to Trash?", entry.name)),
                        )
                        .child(
                            div()
                                .id("cancel-trash")
                                .cursor_pointer()
                                .rounded_lg()
                                .border_1()
                                .border_color(strong_border_color())
                                .px_3()
                                .py_2()
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.pending_trash = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("confirm-trash")
                                .cursor_pointer()
                                .rounded_lg()
                                .bg(danger_color())
                                .px_3()
                                .py_2()
                                .text_color(on_accent_color())
                                .child("Move to Trash")
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.confirm_move_to_trash(cx)),
                                ),
                        ),
                )
            })
            .when_some(pending_rename, |browser, entry| {
                browser.child(
                    div()
                        .flex()
                        .items_end()
                        .gap_3()
                        .px_6()
                        .py_4()
                        .border_b_1()
                        .border_color(border_color())
                        .child(
                            div()
                                .flex_1()
                                .child(field("Rename", Input::new(&self.rename_name).w_full())),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(subtle_color())
                                .child(format!("Current: {}", entry.name)),
                        )
                        .child(
                            div()
                                .id("cancel-rename")
                                .cursor_pointer()
                                .rounded_lg()
                                .border_1()
                                .border_color(strong_border_color())
                                .px_3()
                                .py_2()
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.pending_rename = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("confirm-rename")
                                .cursor_pointer()
                                .rounded_lg()
                                .bg(accent_color())
                                .px_3()
                                .py_2()
                                .text_color(on_accent_color())
                                .child("Rename")
                                .on_click(cx.listener(|this, _, _, cx| this.submit_rename(cx))),
                        ),
                )
            })
            .when(!transfers.is_empty(), |browser| {
                browser.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .px_6()
                        .py_4()
                        .border_b_1()
                        .border_color(border_color())
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(
                                    div()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(transfer_summary),
                                )
                                .child(
                                    div()
                                        .id("toggle-transfers")
                                        .cursor_pointer()
                                        .rounded_lg()
                                        .border_1()
                                        .border_color(strong_border_color())
                                        .px_3()
                                        .py_1()
                                        .child(if transfers_collapsed { "Show" } else { "Hide" })
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.transfers_collapsed = !this.transfers_collapsed;
                                            cx.notify();
                                        })),
                                ),
                        )
                        .when(!transfers_collapsed, |panel| {
                            panel.children(transfers.into_iter().enumerate().map(
                                |(index, transfer)| {
                                    let id = transfer.id.clone();
                                    let dismiss_id = id.clone();
                                    let retry_transfer = transfer.clone();
                                    let active = matches!(
                                        transfer.state,
                                        TransferState::Queued
                                            | TransferState::Sending { .. }
                                            | TransferState::Checking
                                    );
                                    let resumable =
                                        matches!(transfer.state, TransferState::Failed { .. })
                                            && (matches!(
                                                transfer.direction,
                                                TransferDirection::Download
                                            ) || transfer.upload_id.is_some());
                                    let retry_connection = current_connection.clone();
                                    let control = self.transfer_controls.get(&id).cloned();
                                    let speed = transfer_speeds.get(&id).copied();
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap_3()
                                        .rounded_lg()
                                        .bg(tint_color())
                                        .px_3()
                                        .py_2()
                                        .child(
                                            div().flex_1().child(transfer_name(&transfer)).child(
                                                div().text_sm().text_color(subtle_color()).child(
                                                    transfer_state_label(&transfer.state, speed),
                                                ),
                                            ),
                                        )
                                        .when(active && control.is_some(), |row| {
                                            let control = control.expect("checked above");
                                            row.child(
                                                div()
                                                    .id(("cancel-transfer", index))
                                                    .cursor_pointer()
                                                    .rounded_lg()
                                                    .border_1()
                                                    .border_color(strong_border_color())
                                                    .px_3()
                                                    .py_1()
                                                    .child("Cancel")
                                                    .on_click(move |_, _, cx| {
                                                        control.cancel();
                                                        cx.stop_propagation();
                                                    }),
                                            )
                                        })
                                        .when(resumable && retry_connection.is_some(), |row| {
                                            let connection =
                                                retry_connection.expect("checked above");
                                            row.child(
                                                div()
                                                    .id(("retry-transfer", index))
                                                    .cursor_pointer()
                                                    .rounded_lg()
                                                    .bg(accent_color())
                                                    .px_3()
                                                    .py_1()
                                                    .text_color(on_accent_color())
                                                    .child("Retry")
                                                    .on_click(cx.listener(
                                                        move |this, _, _, cx| {
                                                            if matches!(
                                                                retry_transfer.direction,
                                                                TransferDirection::Download
                                                            ) {
                                                                this.start_resume_download(
                                                                    connection.clone(),
                                                                    retry_transfer.clone(),
                                                                    cx,
                                                                );
                                                            } else {
                                                                this.start_resume_upload(
                                                                    connection.clone(),
                                                                    retry_transfer.clone(),
                                                                    cx,
                                                                );
                                                            }
                                                        },
                                                    )),
                                            )
                                        })
                                        .when(!active, |row| {
                                            row.child(
                                                div()
                                                    .id(("dismiss-transfer", index))
                                                    .cursor_pointer()
                                                    .rounded_lg()
                                                    .border_1()
                                                    .border_color(strong_border_color())
                                                    .px_3()
                                                    .py_1()
                                                    .child("Dismiss")
                                                    .on_click(cx.listener(
                                                        move |this, _, _, cx| {
                                                            if dismiss_transfer(&dismiss_id).is_ok()
                                                            {
                                                                this.transfers.retain(|saved| {
                                                                    saved.id != dismiss_id
                                                                });
                                                                this.transfer_controls
                                                                    .remove(&dismiss_id);
                                                                this.transfer_speed_samples
                                                                    .remove(&dismiss_id);
                                                                this.transfer_speeds
                                                                    .remove(&dismiss_id);
                                                                tray::update_status(
                                                                    &this.transfers,
                                                                    cx,
                                                                );
                                                            }
                                                            cx.notify();
                                                        },
                                                    )),
                                            )
                                        })
                                },
                            ))
                        }),
                )
            })
            .when(self.new_folder_open, |browser| {
                browser.child(
                    div()
                        .flex()
                        .items_end()
                        .gap_3()
                        .px_6()
                        .py_4()
                        .border_b_1()
                        .border_color(border_color())
                        .child(
                            div().flex_1().child(field(
                                "Folder name",
                                Input::new(&self.folder_name).w_full(),
                            )),
                        )
                        .child(
                            div()
                                .id("create-folder")
                                .cursor_pointer()
                                .rounded_lg()
                                .bg(accent_color())
                                .px_4()
                                .py_2()
                                .text_color(on_accent_color())
                                .child("Create")
                                .on_click(cx.listener(|this, _, _, cx| this.submit_folder(cx))),
                        )
                        .when_some(self.folder_error.clone(), |row, error| {
                            row.child(div().text_sm().text_color(danger_color()).child(error))
                        }),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .p_6()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .border_b_1()
                            .border_color(strong_border_color())
                            .px_4()
                            .py_2()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(div().w(px(28.0)))
                            .child(
                                div()
                                    .id("sort-name")
                                    .flex_1()
                                    .cursor_pointer()
                                    .child("Name")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.change_sort(SortColumn::Name, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("sort-size")
                                    .w(px(90.0))
                                    .cursor_pointer()
                                    .child("Size")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.change_sort(SortColumn::Size, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("sort-modified")
                                    .w(px(90.0))
                                    .cursor_pointer()
                                    .child("Modified")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.change_sort(SortColumn::Modified, cx)
                                    })),
                            ),
                    )
                    .when_some(status, |list, message| {
                        list.child(
                            div()
                                .p_6()
                                .text_center()
                                .text_color(subtle_color())
                                .child(message),
                        )
                    })
                    .when(credential_error, |list| {
                        let connection = self.current_connection.clone();
                        list.child(
                            div()
                                .id("reenter-credentials")
                                .cursor_pointer()
                                .rounded_lg()
                                .bg(accent_color())
                                .px_4()
                                .py_2()
                                .text_color(on_accent_color())
                                .child("Re-enter credentials")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if let Some(connection) = connection.clone() {
                                        this.begin_edit_connection(connection, window, cx);
                                    }
                                })),
                        )
                    })
                    .children(entries.into_iter().enumerate().map(|(index, entry)| {
                        let folder = matches!(entry.kind, RemoteEntryKind::Folder);
                        let key = entry.key.clone();
                        let select_key = entry.key.clone();
                        let selected = self.selected_keys.contains(&entry.key);
                        let downloadable = entry.clone();
                        let shareable = entry.clone();
                        let trashable = entry.clone();
                        let renameable = entry.clone();
                        let inspectable = entry.clone();
                        let movable = entry.clone();
                        let dragged_entries = if selected {
                            self.selected_entries()
                        } else {
                            vec![entry.clone()]
                        };
                        let drop_destination = entry.key.clone();
                        let allowed_destination = entry.key.clone();
                        let preview = self.previews.get(&entry.key).cloned();
                        let has_preview = preview.is_some();
                        div()
                            .id(("entry", index))
                            .flex()
                            .items_center()
                            .gap_3()
                            .border_b_1()
                            .border_color(tint_color())
                            .bg(surface_color())
                            .px_4()
                            .py_3()
                            .on_drag(
                                DraggedEntries {
                                    entries: dragged_entries,
                                },
                                |drag, _, _, cx| cx.new(|_| drag.clone()),
                            )
                            .when(folder, |row| row.cursor_pointer())
                            .child(
                                div()
                                    .w(px(40.0))
                                    .h(px(40.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_center()
                                    .when_some(preview, |cell, preview| {
                                        cell.child(
                                            img(preview)
                                                .size(px(40.0))
                                                .rounded_lg()
                                                .border_1()
                                                .border_color(strong_border_color()),
                                        )
                                    })
                                    .when(!has_preview, |cell| {
                                        cell.child(if folder {
                                            if selected { "✓" } else { "▸" }
                                        } else if selected {
                                            "✓"
                                        } else {
                                            "·"
                                        })
                                    }),
                            )
                            .child(
                                div()
                                    .id(("move-entry", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_1()
                                    .child("Move")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.prepare_move(vec![movable.clone()], cx);
                                    })),
                            )
                            .child(
                                div()
                                    .id(("select-entry", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(if selected {
                                        accent_color()
                                    } else {
                                        strong_border_color()
                                    })
                                    .px_2()
                                    .py_1()
                                    .child(if selected { "Selected" } else { "Select" })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.toggle_selection(&select_key, cx);
                                    })),
                            )
                            .child(div().flex_1().child(entry.name))
                            .child(
                                div()
                                    .id(("info-entry", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_1()
                                    .child("Info")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.show_info(inspectable.clone(), cx);
                                    })),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(subtle_color())
                                    .child(entry.size.map(format_bytes).unwrap_or_default()),
                            )
                            .child(
                                div()
                                    .w(px(90.0))
                                    .text_sm()
                                    .text_color(subtle_color())
                                    .child(
                                        entry.last_modified.map(format_date).unwrap_or_default(),
                                    ),
                            )
                            .when(!folder, |row| {
                                row.child(
                                    div()
                                        .id(("download-file", index))
                                        .cursor_pointer()
                                        .rounded_lg()
                                        .border_1()
                                        .border_color(strong_border_color())
                                        .px_3()
                                        .py_1()
                                        .child("Download")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.start_download(downloadable.clone(), cx);
                                        })),
                                )
                            })
                            .when(!folder, |row| {
                                row.child(
                                    div()
                                        .id(("share-file", index))
                                        .cursor_pointer()
                                        .rounded_lg()
                                        .border_1()
                                        .border_color(strong_border_color())
                                        .px_3()
                                        .py_1()
                                        .child("Copy link")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.copy_share_link(shareable.clone(), cx);
                                        })),
                                )
                            })
                            .child(
                                div()
                                    .id(("rename-entry", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_1()
                                    .child("Rename")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        cx.stop_propagation();
                                        this.rename_name.update(cx, |input, cx| {
                                            input.set_value(&renameable.name, window, cx)
                                        });
                                        this.pending_rename = Some(renameable.clone());
                                        cx.notify();
                                    })),
                            )
                            .child(
                                div()
                                    .id(("trash-entry", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(danger_border_color())
                                    .px_3()
                                    .py_1()
                                    .text_color(danger_color())
                                    .child("Trash")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.pending_trash = Some(trashable.clone());
                                        cx.notify();
                                    })),
                            )
                            .when(folder, |row| {
                                row.can_drop(move |value, _, _| {
                                    value.downcast_ref::<DraggedEntries>().is_some_and(|drag| {
                                        can_move_entries_to(&drag.entries, &allowed_destination)
                                    })
                                })
                                .drag_over::<DraggedEntries>(|style, _, _, _| {
                                    style.bg(tint_color()).border_color(accent_color())
                                })
                                .on_drop(cx.listener(move |this, drag: &DraggedEntries, _, cx| {
                                    cx.stop_propagation();
                                    this.start_move(
                                        drag.entries.clone(),
                                        drop_destination.clone(),
                                        cx,
                                    );
                                }))
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.load_prefix(key.clone(), cx);
                                    },
                                ))
                            })
                    })),
            )
    }

    fn render_trash(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let items = self.trash_items.clone();
        let status = self.operation_status.clone();
        let pending_delete = self.pending_delete.clone();
        let confirm_empty = self.confirm_empty_trash;
        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_6()
                    .py_4()
                    .border_b_1()
                    .border_color(border_color())
                    .child(
                        div()
                            .id("back-to-storage")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(strong_border_color())
                            .px_3()
                            .py_2()
                            .child("Back")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.screen = Screen::Browser;
                                this.load_prefix(this.prefix.clone(), cx);
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Trash"),
                    )
                    .when(!items.is_empty(), |toolbar| {
                        toolbar.child(
                            div()
                                .id("empty-trash")
                                .cursor_pointer()
                                .rounded_lg()
                                .border_1()
                                .border_color(danger_border_color())
                                .px_3()
                                .py_2()
                                .text_color(danger_color())
                                .child("Empty Trash")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.confirm_empty_trash = true;
                                    cx.notify();
                                })),
                        )
                    }),
            )
            .when_some(status, |view, message| {
                view.child(
                    div()
                        .px_6()
                        .py_2()
                        .bg(warning_surface_color())
                        .text_color(warning_text_color())
                        .child(message),
                )
            })
            .when(confirm_empty, |view| {
                view.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .px_6()
                        .py_4()
                        .bg(danger_surface_color())
                        .child(
                            div()
                                .flex_1()
                                .child("Permanently delete everything in Trash?"),
                        )
                        .child(
                            div()
                                .id("cancel-empty-trash")
                                .cursor_pointer()
                                .px_3()
                                .py_2()
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.confirm_empty_trash = false;
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("confirm-empty-trash")
                                .cursor_pointer()
                                .rounded_lg()
                                .bg(danger_color())
                                .px_3()
                                .py_2()
                                .text_color(on_accent_color())
                                .child("Delete permanently")
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.permanently_empty_trash(cx)),
                                ),
                        ),
                )
            })
            .when_some(pending_delete, |view, item| {
                view.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .px_6()
                        .py_4()
                        .bg(danger_surface_color())
                        .child(
                            div()
                                .flex_1()
                                .child(format!("Permanently delete {}?", item.name)),
                        )
                        .child(
                            div()
                                .id("cancel-delete-trash")
                                .cursor_pointer()
                                .px_3()
                                .py_2()
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.pending_delete = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            div()
                                .id("confirm-delete-trash")
                                .cursor_pointer()
                                .rounded_lg()
                                .bg(danger_color())
                                .px_3()
                                .py_2()
                                .text_color(on_accent_color())
                                .child("Delete permanently")
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.permanently_delete(cx)),
                                ),
                        ),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .p_6()
                    .when(self.trash_loading, |list| {
                        list.child(div().p_6().text_center().child("Loading…"))
                    })
                    .when(!self.trash_loading && items.is_empty(), |list| {
                        list.child(
                            div()
                                .p_6()
                                .text_center()
                                .text_color(subtle_color())
                                .child("Trash is empty"),
                        )
                    })
                    .children(items.into_iter().enumerate().map(|(index, item)| {
                        let restorable = item.clone();
                        let deletable = item.clone();
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .border_b_1()
                            .border_color(tint_color())
                            .bg(surface_color())
                            .px_4()
                            .py_3()
                            .child(div().w(px(28.0)).child(if item.is_folder {
                                "▸"
                            } else {
                                "·"
                            }))
                            .child(
                                div().flex_1().child(item.name).child(
                                    div()
                                        .text_sm()
                                        .text_color(subtle_color())
                                        .child(format_bytes(item.size)),
                                ),
                            )
                            .child(
                                div()
                                    .id(("restore-trash", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .bg(accent_color())
                                    .px_3()
                                    .py_2()
                                    .text_color(on_accent_color())
                                    .child("Restore")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.restore_from_trash(restorable.clone(), cx);
                                    })),
                            )
                            .child(
                                div()
                                    .id(("delete-trash", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(danger_border_color())
                                    .px_3()
                                    .py_2()
                                    .text_color(danger_color())
                                    .child("Delete now")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.pending_delete = Some(deletable.clone());
                                        cx.notify();
                                    })),
                            )
                    })),
            )
    }

    fn render_settings(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let selected_preset = self.tuning.preset.clone();
        let download_dir = self
            .default_download_dir
            .clone()
            .unwrap_or_else(|| "Ask each time".into());
        div()
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .p_6()
            .child(
                div()
                    .w(px(620.0))
                    .flex()
                    .flex_col()
                    .gap_5()
                    .rounded_xl()
                    .border_1()
                    .border_color(border_color())
                    .bg(surface_color())
                    .p_8()
                    .child(
                        div()
                            .text_2xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Settings"),
                    )
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Transfers"))
                    .child(div().flex().gap_3().children(
                        ["slow", "normal", "fast"].into_iter().enumerate().map(
                            |(index, preset)| {
                                let selected = selected_preset == preset;
                                div()
                                    .id(("tuning-preset", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .when(selected, |button| button.bg(tint_color()))
                                    .px_4()
                                    .py_2()
                                    .child(match preset {
                                        "slow" => "Slow",
                                        "fast" => "Fast",
                                        _ => "Normal",
                                    })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.choose_tuning(preset, cx)
                                    }))
                            },
                        ),
                    ))
                    .child(div().text_sm().text_color(subtle_color()).child(format!(
                        "{} files at once · {} upload parts · {} download connections",
                        self.tuning.concurrent_files,
                        self.tuning.upload_parts_in_flight,
                        self.tuning.download_connections
                    )))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Downloads"))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(
                                div()
                                    .flex_1()
                                    .text_sm()
                                    .text_color(subtle_color())
                                    .child(download_dir),
                            )
                            .child(
                                div()
                                    .id("choose-download-folder")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_2()
                                    .child("Choose folder")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.choose_download_folder(cx)
                                    })),
                            )
                            .when(self.default_download_dir.is_some(), |row| {
                                row.child(
                                    div()
                                        .id("clear-download-folder")
                                        .cursor_pointer()
                                        .px_3()
                                        .py_2()
                                        .child("Clear")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            if set_default_download_dir(None).is_ok() {
                                                this.default_download_dir = None;
                                            }
                                            cx.notify();
                                        })),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(
                                div()
                                    .flex_1()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Check for updates automatically"),
                            )
                            .child(
                                div()
                                    .id("toggle-auto-update")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .bg(if self.auto_update_enabled {
                                        accent_color()
                                    } else {
                                        tint_color()
                                    })
                                    .px_4()
                                    .py_2()
                                    .text_color(if self.auto_update_enabled {
                                        on_accent_color()
                                    } else {
                                        text_color()
                                    })
                                    .child(if self.auto_update_enabled {
                                        "On"
                                    } else {
                                        "Off"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let enabled = !this.auto_update_enabled;
                                        if set_auto_update_enabled(enabled).is_ok() {
                                            this.auto_update_enabled = enabled;
                                        }
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Maintenance"))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(div().flex_1().child("Clean up interrupted uploads").child(
                                div().text_sm().text_color(subtle_color()).child(
                                    "Removes abandoned upload fragments that still use storage.",
                                ),
                            ))
                            .child(
                                div()
                                    .id("clean-up-stale-uploads")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_2()
                                    .child(if self.cleaning_stale_uploads {
                                        "Cleaning up…"
                                    } else {
                                        "Clean up"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.clean_up_stale_uploads(cx)
                                    })),
                            ),
                    )
                    .when_some(self.settings_status.clone(), |panel, status| {
                        panel.child(div().text_sm().text_color(accent_color()).child(status))
                    })
                    .child(
                        div()
                            .id("close-settings")
                            .cursor_pointer()
                            .rounded_lg()
                            .bg(accent_color())
                            .px_4()
                            .py_2()
                            .text_color(on_accent_color())
                            .child("Done")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.screen = Screen::Home;
                                cx.notify();
                            })),
                    ),
            )
    }
}

impl Render for LoploadApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.system_is_dark = is_dark_appearance(window);
        set_dark_appearance(self.theme_mode, self.system_is_dark);
        let content = match self.screen {
            Screen::Home => self.render_home(cx).into_any_element(),
            Screen::AddStorage => self.render_add_storage(cx).into_any_element(),
            Screen::Celebration => self.render_celebration(cx).into_any_element(),
            Screen::Browser => self.render_browser(cx).into_any_element(),
            Screen::Trash => self.render_trash(cx).into_any_element(),
            Screen::Settings => self.render_settings(cx).into_any_element(),
        };

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(canvas_color())
            .text_color(text_color())
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_6()
                    .py_4()
                    .border_b_1()
                    .border_color(border_color())
                    .bg(surface_color())
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Lopload"),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .id("toggle-theme")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_2()
                                    .child(if DARK_APPEARANCE.load(AtomicOrdering::Relaxed) {
                                        "Light mode"
                                    } else {
                                        "Dark mode"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let next = if DARK_APPEARANCE.load(AtomicOrdering::Relaxed)
                                        {
                                            ThemeMode::Light
                                        } else {
                                            ThemeMode::Dark
                                        };
                                        if set_theme_mode(next).is_ok() {
                                            this.theme_mode = Some(next);
                                            set_dark_appearance(
                                                this.theme_mode,
                                                this.system_is_dark,
                                            );
                                        }
                                        cx.notify();
                                    })),
                            )
                            .child(
                                div()
                                    .id("open-settings")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(strong_border_color())
                                    .px_3()
                                    .py_2()
                                    .child("Settings")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.screen = Screen::Settings;
                                        this.settings_status = None;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(content)
    }
}

fn field(label: &'static str, input: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_2()
        .child(div().text_sm().child(label))
        .child(input)
}

fn is_dark_appearance(window: &Window) -> bool {
    matches!(
        window.appearance(),
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    )
}

fn set_dark_appearance(mode: Option<ThemeMode>, system_is_dark: bool) {
    let is_dark = match mode {
        Some(ThemeMode::Light) => false,
        Some(ThemeMode::Dark) => true,
        None => system_is_dark,
    };
    DARK_APPEARANCE.store(is_dark, AtomicOrdering::Relaxed);
}

fn themed_color(light: u32, dark: u32) -> Rgba {
    rgb(if DARK_APPEARANCE.load(AtomicOrdering::Relaxed) {
        dark
    } else {
        light
    })
}

fn canvas_color() -> Rgba {
    themed_color(0xf7f5ff, 0x181521)
}

fn surface_color() -> Rgba {
    themed_color(0xffffff, 0x211d2e)
}

fn text_color() -> Rgba {
    themed_color(0x29243a, 0xf4f0ff)
}

fn subtle_color() -> Rgba {
    themed_color(0x766d91, 0xb6accd)
}

fn border_color() -> Rgba {
    themed_color(0xe3def2, 0x3c354f)
}

fn strong_border_color() -> Rgba {
    themed_color(0xd4cee8, 0x514865)
}

fn accent_color() -> Rgba {
    themed_color(0x5c4f8f, 0xa998e8)
}

fn tint_color() -> Rgba {
    themed_color(0xeeeafa, 0x322a48)
}

fn strong_tint_color() -> Rgba {
    themed_color(0xded7f5, 0x473c66)
}

fn danger_color() -> Rgba {
    themed_color(0xa33b53, 0xff9caf)
}

fn danger_border_color() -> Rgba {
    themed_color(0xe9b9c4, 0x774757)
}

fn danger_surface_color() -> Rgba {
    themed_color(0xffedf1, 0x3a202a)
}

fn warning_surface_color() -> Rgba {
    themed_color(0xfff4d8, 0x3b301c)
}

fn warning_text_color() -> Rgba {
    themed_color(0x6e5520, 0xf4d38a)
}

fn on_accent_color() -> Rgba {
    rgb(0xffffff)
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn initial_screen(first_run: bool) -> Screen {
    if first_run {
        Screen::AddStorage
    } else {
        Screen::Home
    }
}

fn screen_after_connection_save(first_connection: bool) -> Screen {
    if first_connection {
        Screen::Celebration
    } else {
        Screen::Home
    }
}

fn format_operation_progress(
    action: &str,
    progress: &lopload_native::operations::OperationProgress,
) -> String {
    if progress.total_bytes > 0 {
        format!(
            "{action}… {} of {} · {} of {}",
            progress.completed_items,
            progress.total_items,
            format_bytes(progress.completed_bytes),
            format_bytes(progress.total_bytes)
        )
    } else {
        format!(
            "{action}… {} of {}",
            progress.completed_items, progress.total_items
        )
    }
}

fn format_date(timestamp: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp)
        .single()
        .map(|date| date.format("%d/%m/%Y").to_string())
        .unwrap_or_default()
}

fn image_format(name: &str) -> Option<ImageFormat> {
    match Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "webp" => Some(ImageFormat::Webp),
        "gif" => Some(ImageFormat::Gif),
        "svg" => Some(ImageFormat::Svg),
        "bmp" => Some(ImageFormat::Bmp),
        "tif" | "tiff" => Some(ImageFormat::Tiff),
        _ => None,
    }
}

fn transfer_name(transfer: &Transfer) -> String {
    match transfer.direction {
        TransferDirection::Upload => std::path::Path::new(&transfer.local_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("File")
            .to_string(),
        TransferDirection::Download => transfer
            .remote_key
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("File")
            .to_string(),
    }
}

fn transfer_summary(transfers: &[Transfer]) -> String {
    let active = transfers
        .iter()
        .filter(|transfer| {
            matches!(
                transfer.state,
                TransferState::Queued | TransferState::Sending { .. } | TransferState::Checking
            )
        })
        .count();
    let failed = transfers
        .iter()
        .filter(|transfer| matches!(transfer.state, TransferState::Failed { .. }))
        .count();
    let completed = transfers.len() - active - failed;
    let mut parts = Vec::new();
    if active > 0 {
        parts.push(format!("{active} active"));
    }
    if completed > 0 {
        parts.push(format!("{completed} completed"));
    }
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }
    format!("Transfers · {}", parts.join(" · "))
}

fn transfer_completion_message(
    direction: &TransferDirection,
    succeeded: usize,
    failed: usize,
) -> Option<(String, String)> {
    let total = succeeded + failed;
    if total == 0 {
        return None;
    }
    let action = match direction {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
    };
    let title = if total == 1 {
        format!("{} complete", uppercase_first(action))
    } else {
        format!("{}s complete", uppercase_first(action))
    };
    let completed = match direction {
        TransferDirection::Upload => "uploaded",
        TransferDirection::Download => "downloaded",
    };
    let files = |count| if count == 1 { "file" } else { "files" };
    let body = match (succeeded, failed) {
        (0, failed) => format!("{failed} {} failed", files(failed)),
        (succeeded, 0) => format!("{succeeded} {} {completed}", files(succeeded)),
        (succeeded, failed) => format!(
            "{succeeded} {} {completed} · {failed} {} failed",
            files(succeeded),
            files(failed)
        ),
    };
    Some((title, body))
}

fn notify_transfer_completion(direction: TransferDirection, succeeded: usize, failed: usize) {
    let Some((title, body)) = transfer_completion_message(&direction, succeeded, failed) else {
        return;
    };
    let _ = Notification::new()
        .appname("Lopload")
        .summary(&title)
        .body(&body)
        .show();
}

fn uppercase_first(value: &str) -> String {
    let mut characters = value.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
        .unwrap_or_default()
}

fn transfer_state_label(state: &TransferState, speed: Option<u64>) -> String {
    match state {
        TransferState::Queued => "Waiting".into(),
        TransferState::Sending { percent } => speed.map_or_else(
            || format!("Transferring… {percent:.0}%"),
            |speed| format!("Transferring… {percent:.0}% · {}/s", format_bytes(speed)),
        ),
        TransferState::Checking => "Checking file…".into(),
        TransferState::Uploaded => "Uploaded ✓".into(),
        TransferState::Downloaded => "Downloaded ✓".into(),
        TransferState::Failed { error_class } => match error_class {
            ErrorClass::Offline => "Failed — you appear to be offline",
            ErrorClass::Credentials => "Failed — check your credentials",
            ErrorClass::StorageFull => "Failed — the destination is full",
            ErrorClass::ConnectionDropped => "Failed — the connection was interrupted",
            ErrorClass::Verification => "Failed — the file could not be verified",
            ErrorClass::NotFound => "Failed — the file was not found",
            ErrorClass::Unknown => "Failed — try again",
        }
        .into(),
    }
}

fn browser_status_message(
    status: &BrowserStatus,
    unfiltered_count: usize,
    filtered_count: usize,
    has_filter: bool,
) -> Option<String> {
    match status {
        BrowserStatus::Idle if has_filter && unfiltered_count > 0 && filtered_count == 0 => {
            Some("No matches — nothing in this folder matches your filter".into())
        }
        BrowserStatus::Idle if unfiltered_count == 0 => {
            Some("This folder is empty — drag files in, or use Upload files".into())
        }
        BrowserStatus::Idle => None,
        BrowserStatus::Loading => Some("Loading…".into()),
        BrowserStatus::Failed(error) => Some(error.clone()),
    }
}

fn expand_upload_paths(paths: &[PathBuf]) -> Vec<(PathBuf, String)> {
    paths
        .iter()
        .filter(|path| {
            std::fs::symlink_metadata(path)
                .map(|metadata| metadata.file_type().is_file())
                .unwrap_or(false)
        })
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().to_string();
            Some((path.clone(), name))
        })
        .collect()
}

fn safe_destination(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut destination = root.to_path_buf();
    let mut found_name = false;
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            return None;
        };
        found_name = true;
        destination.push(name);
        if std::fs::symlink_metadata(&destination)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return None;
        }
    }
    found_name.then_some(destination)
}

fn parent_of_key(key: &str) -> String {
    let trimmed = key.trim_end_matches('/');
    trimmed
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/"))
        .unwrap_or_default()
}

fn can_move_entries_to(entries: &[RemoteEntry], destination: &str) -> bool {
    !entries.is_empty()
        && entries.iter().all(|entry| {
            parent_of_key(&entry.key) != destination
                && (!matches!(entry.kind, RemoteEntryKind::Folder)
                    || !destination.starts_with(&entry.key))
        })
}

fn main() {
    Application::new().run(|cx: &mut App| {
        gpui_component::init(cx);
        let bounds = Bounds::centered(None, size(px(1100.0), px(720.0)), cx);
        let window_handle = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Lopload".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    let view = cx.new(|cx| LoploadApp::new(window, cx));
                    cx.new(|cx| Root::new(view, window, cx))
                },
            )
            .expect("failed to open Lopload window");
        match tray::setup(cx) {
            Ok(receiver) => {
                let _ = window_handle.update(cx, |_, window, cx| {
                    window.on_window_should_close(cx, |_, cx| {
                        cx.hide();
                        false
                    });
                });
                cx.spawn(async move |cx| {
                    while let Ok(command) = receiver.recv().await {
                        match command {
                            tray::TrayCommand::Show => {
                                let _ = cx.update(|cx| cx.activate(false));
                                let _ = window_handle.update(cx, |_, window, _| {
                                    window.activate_window();
                                });
                            }
                            tray::TrayCommand::Quit => {
                                let _ = cx.update(|cx| cx.quit());
                                break;
                            }
                        }
                    }
                })
                .detach();
            }
            Err(error) => eprintln!("Lopload tray unavailable: {error}"),
        }
        cx.activate(true);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn keeps_bulk_downloads_inside_the_chosen_folder() {
        let root = Path::new("/tmp/downloads");
        assert_eq!(
            safe_destination(root, "photos/cat.jpg"),
            Some(root.join("photos/cat.jpg"))
        );
        assert_eq!(safe_destination(root, "../private.txt"), None);
        assert_eq!(safe_destination(root, "/absolute.txt"), None);
    }

    #[test]
    fn guards_internal_move_destinations() {
        let file = RemoteEntry {
            kind: RemoteEntryKind::File,
            name: "notes.txt".into(),
            key: "work/notes.txt".into(),
            size: Some(4),
            last_modified: None,
        };
        let folder = RemoteEntry {
            kind: RemoteEntryKind::Folder,
            name: "photos".into(),
            key: "work/photos/".into(),
            size: None,
            last_modified: None,
        };

        assert!(can_move_entries_to(std::slice::from_ref(&file), "archive/"));
        assert!(!can_move_entries_to(std::slice::from_ref(&file), "work/"));
        assert!(!can_move_entries_to(
            std::slice::from_ref(&folder),
            "work/photos/"
        ));
        assert!(!can_move_entries_to(
            std::slice::from_ref(&folder),
            "work/photos/edited/"
        ));
        assert!(!can_move_entries_to(&[], "archive/"));
    }

    #[test]
    fn summarizes_transfer_batches() {
        let transfers = vec![
            transfer(TransferState::Sending { percent: 50.0 }),
            transfer(TransferState::Uploaded),
            transfer(TransferState::Failed {
                error_class: ErrorClass::Offline,
            }),
        ];

        assert_eq!(
            transfer_summary(&transfers),
            "Transfers · 1 active · 1 completed · 1 failed"
        );
        assert_eq!(
            transfer_state_label(&TransferState::Sending { percent: 50.0 }, Some(1024)),
            "Transferring… 50% · 1.0 KB/s"
        );
        assert_eq!(
            transfer_completion_message(&TransferDirection::Upload, 2, 1),
            Some((
                "Uploads complete".into(),
                "2 files uploaded · 1 file failed".into()
            ))
        );
        assert_eq!(
            transfer_completion_message(&TransferDirection::Download, 1, 0),
            Some(("Download complete".into(), "1 file downloaded".into()))
        );
        assert_eq!(
            transfer_completion_message(&TransferDirection::Upload, 0, 0),
            None
        );
    }

    #[test]
    fn distinguishes_empty_folders_from_empty_filter_results() {
        assert_eq!(
            browser_status_message(&BrowserStatus::Idle, 0, 0, false).as_deref(),
            Some("This folder is empty — drag files in, or use Upload files")
        );
        assert_eq!(
            browser_status_message(&BrowserStatus::Idle, 3, 0, true).as_deref(),
            Some("No matches — nothing in this folder matches your filter")
        );
        assert_eq!(
            browser_status_message(&BrowserStatus::Idle, 3, 2, true),
            None
        );
    }

    #[test]
    fn recognizes_native_image_previews() {
        assert_eq!(image_format("photo.JPG"), Some(ImageFormat::Jpeg));
        assert_eq!(image_format("diagram.svg"), Some(ImageFormat::Svg));
        assert_eq!(image_format("archive.zip"), None);
        assert_eq!(image_format("no-extension"), None);
    }

    #[test]
    fn routes_the_first_connection_through_onboarding() {
        assert_eq!(initial_screen(true), Screen::AddStorage);
        assert_eq!(initial_screen(false), Screen::Home);
        assert_eq!(screen_after_connection_save(true), Screen::Celebration);
        assert_eq!(screen_after_connection_save(false), Screen::Home);
    }
}
