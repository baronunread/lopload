use gpui::{
    App, AppContext, Application, Bounds, ClipboardItem, Context, Entity, ExternalPaths,
    FontWeight, Render, Window, WindowBounds, WindowOptions, div, prelude::*, px, rgb, size,
};
use gpui_component::{
    Root,
    input::{Input, InputState},
    scroll::ScrollableElement,
};
use lopload_native::{
    NewStorageConnection, StorageConnection, UpdateStorageConnection, delete_connection,
    list_connections,
    operations::{
        TrashItem, delete_trash_item, empty_trash, list_trash, move_to_trash, rename_file,
        rename_folder, restore_trash_item, share_link,
    },
    s3::{RemoteEntry, RemoteEntryKind, create_folder as create_remote_folder, list_entries},
    save_connection, set_last_prefix,
    settings::{
        TransferTuning, auto_update_enabled, default_download_dir, set_auto_update_enabled,
        set_default_download_dir, set_transfer_tuning, transfer_tuning,
    },
    transfer::{
        ErrorClass, Transfer, TransferControl, TransferDirection, TransferState, dismiss_transfer,
        download_file, list_transfers, resume_download, resume_upload, upload_file,
    },
    update_connection,
};
use std::{collections::HashMap, path::PathBuf};

#[derive(Clone, Copy)]
enum Screen {
    Home,
    AddStorage,
    Browser,
    Trash,
    Settings,
}

enum BrowserStatus {
    Idle,
    Loading,
    Failed(String),
}

enum TransferEvent {
    Update(Transfer, TransferControl),
    Removed(String),
    Status(String),
}

struct LoploadApp {
    screen: Screen,
    connections: Vec<StorageConnection>,
    current_connection: Option<StorageConnection>,
    prefix: String,
    entries: Vec<RemoteEntry>,
    browser_status: BrowserStatus,
    load_generation: u64,
    transfers: Vec<Transfer>,
    transfer_controls: HashMap<String, TransferControl>,
    trash_items: Vec<TrashItem>,
    trash_loading: bool,
    pending_trash: Option<RemoteEntry>,
    pending_rename: Option<RemoteEntry>,
    pending_delete: Option<TrashItem>,
    confirm_empty_trash: bool,
    operation_status: Option<String>,
    tuning: TransferTuning,
    auto_update_enabled: bool,
    default_download_dir: Option<String>,
    settings_status: Option<String>,
    name: Entity<InputState>,
    endpoint: Entity<InputState>,
    bucket: Entity<InputState>,
    region: Entity<InputState>,
    access_key: Entity<InputState>,
    secret_key: Entity<InputState>,
    folder_name: Entity<InputState>,
    rename_name: Entity<InputState>,
    form_error: Option<String>,
    editing_connection_id: Option<String>,
    connection_test_status: Option<String>,
    testing_connection: bool,
    folder_error: Option<String>,
    new_folder_open: bool,
    home_error: Option<String>,
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
        let auto_update_enabled = auto_update_enabled().unwrap_or(true);
        let default_download_dir = default_download_dir().unwrap_or_default();
        Self {
            screen: Screen::Home,
            connections,
            current_connection: None,
            prefix: String::new(),
            entries: Vec::new(),
            browser_status: BrowserStatus::Idle,
            load_generation: 0,
            transfers: Vec::new(),
            transfer_controls: HashMap::new(),
            trash_items: Vec::new(),
            trash_loading: false,
            pending_trash: None,
            pending_rename: None,
            pending_delete: None,
            confirm_empty_trash: false,
            operation_status: None,
            tuning,
            auto_update_enabled,
            default_download_dir,
            settings_status: None,
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
            form_error: None,
            editing_connection_id: None,
            connection_test_status: None,
            testing_connection: false,
            folder_error: None,
            new_folder_open: false,
            home_error,
        }
    }

    fn open_connection(&mut self, connection: StorageConnection, cx: &mut Context<Self>) {
        let prefix = connection.last_prefix.clone();
        self.transfers = list_transfers(&connection.id).unwrap_or_default();
        self.transfer_controls.clear();
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
                let _ = resume_upload(&connection, transfer, &control, |updated| {
                    transfer_id = Some(updated.id.clone());
                    let _ =
                        sender.send_blocking(TransferEvent::Update(updated, event_control.clone()));
                });
                if control.is_cancelled() {
                    if let Some(id) = transfer_id {
                        let _ = sender.send_blocking(TransferEvent::Removed(id));
                    }
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
                let _ = resume_download(&connection, transfer, &control, |updated| {
                    let _ =
                        sender.send_blocking(TransferEvent::Update(updated, event_control.clone()));
                });
                if control.is_cancelled() {
                    let _ = sender.send_blocking(TransferEvent::Removed(id));
                }
            })
            .detach();
    }

    fn record_transfer(&mut self, transfer: Transfer, cx: &mut Context<Self>) {
        if let Some(saved) = self
            .transfers
            .iter_mut()
            .find(|saved| saved.id == transfer.id)
        {
            *saved = transfer.clone();
        } else {
            self.transfers.push(transfer.clone());
        }
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
        let is_folder = matches!(entry.kind, RemoteEntryKind::Folder);
        let deleted_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        let operation = cx
            .background_executor()
            .spawn(async move { move_to_trash(&connection, &key, is_folder, deleted_at) });
        cx.spawn(async move |this, cx| {
            let result = operation.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        this.operation_status = Some("Moved to Trash".into());
                        this.load_prefix(this.prefix.clone(), cx);
                    }
                    Err(error) => {
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
        self.operation_status = Some("Renaming…".into());
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

    fn restore_from_trash(&mut self, item: TrashItem, cx: &mut Context<Self>) {
        let Some(connection) = self.current_connection.clone() else {
            return;
        };
        self.operation_status = Some("Restoring…".into());
        let operation = cx
            .background_executor()
            .spawn(async move { restore_trash_item(&connection, &item) });
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
        let operation = cx
            .background_executor()
            .spawn(async move { delete_trash_item(&connection, &item) });
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
        let operation = cx
            .background_executor()
            .spawn(async move { empty_trash(&connection) });
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
                for group in files.chunks(concurrency) {
                    std::thread::scope(|scope| {
                        for (path, relative_key) in group.iter().cloned() {
                            let connection = connection.clone();
                            let prefix = prefix.clone();
                            let sender = sender.clone();
                            scope.spawn(move || {
                                let key = format!("{prefix}{relative_key}");
                                let control = TransferControl::default();
                                let event_control = control.clone();
                                let mut transfer_id = None;
                                let _ =
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
                                }
                            });
                        }
                    });
                }
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
                let _ = download_file(
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
                }
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
                        }
                        Err(error) => this.browser_status = BrowserStatus::Failed(error),
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
        let name = self.folder_name.read(cx).value().to_string();
        self.folder_error = None;
        let create = cx
            .background_executor()
            .spawn(async move { create_remote_folder(&connection, &prefix, &name) });
        cx.spawn(async move |this, cx| {
            let result = create.await;
            if let Some(this) = this.upgrade() {
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => {
                        this.new_folder_open = false;
                        this.load_prefix(this.prefix.clone(), cx);
                    }
                    Err(error) => {
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
                        .text_color(rgb(0x766d91))
                        .child("Choose a connection or add another one."),
                )
                .when_some(self.home_error.clone(), |panel, error| {
                    panel.child(div().text_sm().text_color(rgb(0xa33b53)).child(error))
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
                                .border_color(rgb(0xe3def2))
                                .bg(rgb(0xffffff))
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
                                                .border_color(rgb(0xd4cee8))
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
                                                .text_color(rgb(0x766d91))
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
                                                .bg(rgb(0xeeeafa))
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
                                                .border_color(rgb(0xe9b9c4))
                                                .px_3()
                                                .py_2()
                                                .text_color(rgb(0xa33b53))
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
                        .bg(rgb(0x5c4f8f))
                        .px_4()
                        .py_2()
                        .text_color(rgb(0xffffff))
                        .child("Add storage")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.begin_add_connection(window, cx);
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
                    .border_color(rgb(0xe3def2))
                    .bg(rgb(0xffffff))
                    .shadow_lg()
                    .child(
                        div()
                            .text_2xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(if editing { "Edit storage" } else { "Add storage" }),
                    )
                    .child(
                        div()
                            .text_color(rgb(0x766d91))
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
                        panel.child(div().text_sm().text_color(rgb(0xa33b53)).child(error))
                    })
                    .when_some(self.connection_test_status.clone(), |panel, status| {
                        panel.child(div().text_sm().text_color(rgb(0x5c4f8f)).child(status))
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
                                    .border_color(rgb(0xd4cee8))
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
                                    .border_color(rgb(0xd4cee8))
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
                                    .bg(rgb(0x5c4f8f))
                                    .px_4()
                                    .py_2()
                                    .text_color(rgb(0xffffff))
                                    .child("Save storage")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        let name = this.name.read(cx).value().to_string();
                                        let endpoint = this.endpoint.read(cx).value().to_string();
                                        let bucket = this.bucket.read(cx).value().to_string();
                                        let region = this.region.read(cx).value().to_string();
                                        let access_key = this.access_key.read(cx).value().to_string();
                                        let secret_key = this.secret_key.read(cx).value().to_string();
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
                                                this.screen = Screen::Home;
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
        let entries = self.entries.clone();
        let transfers = self.transfers.clone();
        let current_connection = self.current_connection.clone();
        let pending_trash = self.pending_trash.clone();
        let pending_rename = self.pending_rename.clone();
        let operation_status = self.operation_status.clone();
        let status = match &self.browser_status {
            BrowserStatus::Idle if entries.is_empty() => Some("This folder is empty".to_string()),
            BrowserStatus::Idle => None,
            BrowserStatus::Loading => Some("Loading…".to_string()),
            BrowserStatus::Failed(error) => Some(error.clone()),
        };

        div()
            .flex_1()
            .flex()
            .flex_col()
            .min_h_0()
            .drag_over::<ExternalPaths>(|style, _, _, _| style.bg(rgb(0xeeeafa)))
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
                    .border_color(rgb(0xe3def2))
                    .child(
                        div()
                            .id("all-storage")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(rgb(0xd4cee8))
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
                            .border_color(rgb(0xd4cee8))
                            .px_3()
                            .py_2()
                            .child("Trash")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.operation_status = None;
                                this.open_trash(cx);
                            })),
                    )
                    .when(!prefix.is_empty(), |toolbar| {
                        toolbar.child(
                            div()
                                .id("up")
                                .cursor_pointer()
                                .rounded_lg()
                                .border_1()
                                .border_color(rgb(0xd4cee8))
                                .px_3()
                                .py_2()
                                .child("Up")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.load_prefix(parent.clone(), cx);
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
                            .child(div().text_sm().text_color(rgb(0x766d91)).child(
                                if prefix.is_empty() {
                                    "Home".to_string()
                                } else {
                                    format!("Home / {}", prefix.trim_end_matches('/'))
                                },
                            )),
                    )
                    .child(
                        div()
                            .id("upload-files")
                            .cursor_pointer()
                            .rounded_lg()
                            .bg(rgb(0x5c4f8f))
                            .px_3()
                            .py_2()
                            .text_color(rgb(0xffffff))
                            .child("Upload files")
                            .on_click(cx.listener(|this, _, _, cx| this.start_upload(cx))),
                    )
                    .child(
                        div()
                            .id("new-folder")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(rgb(0xd4cee8))
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
                            .bg(rgb(0xeeeafa))
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
                        .bg(rgb(0xfff4d8))
                        .text_color(rgb(0x6e5520))
                        .child(status),
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
                        .border_color(rgb(0xe9b9c4))
                        .bg(rgb(0xffedf1))
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
                                .border_color(rgb(0xd4cee8))
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
                                .bg(rgb(0xa33b53))
                                .px_3()
                                .py_2()
                                .text_color(rgb(0xffffff))
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
                        .border_color(rgb(0xe3def2))
                        .child(
                            div()
                                .flex_1()
                                .child(field("Rename", Input::new(&self.rename_name).w_full())),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(rgb(0x766d91))
                                .child(format!("Current: {}", entry.name)),
                        )
                        .child(
                            div()
                                .id("cancel-rename")
                                .cursor_pointer()
                                .rounded_lg()
                                .border_1()
                                .border_color(rgb(0xd4cee8))
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
                                .bg(rgb(0x5c4f8f))
                                .px_3()
                                .py_2()
                                .text_color(rgb(0xffffff))
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
                        .border_color(rgb(0xe3def2))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child("Transfers"))
                        .children(transfers.into_iter().enumerate().map(|(index, transfer)| {
                            let id = transfer.id.clone();
                            let dismiss_id = id.clone();
                            let retry_transfer = transfer.clone();
                            let active = matches!(
                                transfer.state,
                                TransferState::Queued
                                    | TransferState::Sending { .. }
                                    | TransferState::Checking
                            );
                            let resumable = matches!(transfer.state, TransferState::Failed { .. })
                                && (matches!(transfer.direction, TransferDirection::Download)
                                    || transfer.upload_id.is_some());
                            let retry_connection = current_connection.clone();
                            let control = self.transfer_controls.get(&id).cloned();
                            div()
                                .flex()
                                .items_center()
                                .gap_3()
                                .rounded_lg()
                                .bg(rgb(0xeeeafa))
                                .px_3()
                                .py_2()
                                .child(
                                    div().flex_1().child(transfer_name(&transfer)).child(
                                        div()
                                            .text_sm()
                                            .text_color(rgb(0x766d91))
                                            .child(transfer_state_label(&transfer.state)),
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
                                            .border_color(rgb(0xd4cee8))
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
                                    let connection = retry_connection.expect("checked above");
                                    row.child(
                                        div()
                                            .id(("retry-transfer", index))
                                            .cursor_pointer()
                                            .rounded_lg()
                                            .bg(rgb(0x5c4f8f))
                                            .px_3()
                                            .py_1()
                                            .text_color(rgb(0xffffff))
                                            .child("Retry")
                                            .on_click(cx.listener(move |this, _, _, cx| {
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
                                            })),
                                    )
                                })
                                .when(!active, |row| {
                                    row.child(
                                        div()
                                            .id(("dismiss-transfer", index))
                                            .cursor_pointer()
                                            .rounded_lg()
                                            .border_1()
                                            .border_color(rgb(0xd4cee8))
                                            .px_3()
                                            .py_1()
                                            .child("Dismiss")
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                if dismiss_transfer(&dismiss_id).is_ok() {
                                                    this.transfers
                                                        .retain(|saved| saved.id != dismiss_id);
                                                    this.transfer_controls.remove(&dismiss_id);
                                                }
                                                cx.notify();
                                            })),
                                    )
                                })
                        })),
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
                        .border_color(rgb(0xe3def2))
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
                                .bg(rgb(0x5c4f8f))
                                .px_4()
                                .py_2()
                                .text_color(rgb(0xffffff))
                                .child("Create")
                                .on_click(cx.listener(|this, _, _, cx| this.submit_folder(cx))),
                        )
                        .when_some(self.folder_error.clone(), |row, error| {
                            row.child(div().text_sm().text_color(rgb(0xa33b53)).child(error))
                        }),
                )
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .p_6()
                    .when_some(status, |list, message| {
                        list.child(
                            div()
                                .p_6()
                                .text_center()
                                .text_color(rgb(0x766d91))
                                .child(message),
                        )
                    })
                    .children(entries.into_iter().enumerate().map(|(index, entry)| {
                        let folder = matches!(entry.kind, RemoteEntryKind::Folder);
                        let key = entry.key.clone();
                        let downloadable = entry.clone();
                        let shareable = entry.clone();
                        let trashable = entry.clone();
                        let renameable = entry.clone();
                        div()
                            .id(("entry", index))
                            .flex()
                            .items_center()
                            .gap_3()
                            .border_b_1()
                            .border_color(rgb(0xeeeafa))
                            .bg(rgb(0xffffff))
                            .px_4()
                            .py_3()
                            .when(folder, |row| row.cursor_pointer())
                            .child(div().w(px(28.0)).text_center().child(if folder {
                                "▸"
                            } else {
                                "·"
                            }))
                            .child(div().flex_1().child(entry.name))
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(rgb(0x766d91))
                                    .child(entry.size.map(format_bytes).unwrap_or_default()),
                            )
                            .when(!folder, |row| {
                                row.child(
                                    div()
                                        .id(("download-file", index))
                                        .cursor_pointer()
                                        .rounded_lg()
                                        .border_1()
                                        .border_color(rgb(0xd4cee8))
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
                                        .border_color(rgb(0xd4cee8))
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
                                    .border_color(rgb(0xd4cee8))
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
                                    .border_color(rgb(0xe9b9c4))
                                    .px_3()
                                    .py_1()
                                    .text_color(rgb(0xa33b53))
                                    .child("Trash")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        cx.stop_propagation();
                                        this.pending_trash = Some(trashable.clone());
                                        cx.notify();
                                    })),
                            )
                            .when(folder, |row| {
                                row.on_click(cx.listener(move |this, _, _, cx| {
                                    this.load_prefix(key.clone(), cx);
                                }))
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
                    .border_color(rgb(0xe3def2))
                    .child(
                        div()
                            .id("back-to-storage")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(rgb(0xd4cee8))
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
                                .border_color(rgb(0xe9b9c4))
                                .px_3()
                                .py_2()
                                .text_color(rgb(0xa33b53))
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
                        .bg(rgb(0xfff4d8))
                        .text_color(rgb(0x6e5520))
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
                        .bg(rgb(0xffedf1))
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
                                .bg(rgb(0xa33b53))
                                .px_3()
                                .py_2()
                                .text_color(rgb(0xffffff))
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
                        .bg(rgb(0xffedf1))
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
                                .bg(rgb(0xa33b53))
                                .px_3()
                                .py_2()
                                .text_color(rgb(0xffffff))
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
                                .text_color(rgb(0x766d91))
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
                            .border_color(rgb(0xeeeafa))
                            .bg(rgb(0xffffff))
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
                                        .text_color(rgb(0x766d91))
                                        .child(format_bytes(item.size)),
                                ),
                            )
                            .child(
                                div()
                                    .id(("restore-trash", index))
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .bg(rgb(0x5c4f8f))
                                    .px_3()
                                    .py_2()
                                    .text_color(rgb(0xffffff))
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
                                    .border_color(rgb(0xe9b9c4))
                                    .px_3()
                                    .py_2()
                                    .text_color(rgb(0xa33b53))
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
                    .border_color(rgb(0xe3def2))
                    .bg(rgb(0xffffff))
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
                                    .border_color(rgb(0xd4cee8))
                                    .when(selected, |button| button.bg(rgb(0xeeeafa)))
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
                    .child(div().text_sm().text_color(rgb(0x766d91)).child(format!(
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
                                    .text_color(rgb(0x766d91))
                                    .child(download_dir),
                            )
                            .child(
                                div()
                                    .id("choose-download-folder")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .border_1()
                                    .border_color(rgb(0xd4cee8))
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
                                    .bg(rgb(if self.auto_update_enabled {
                                        0x5c4f8f
                                    } else {
                                        0xeeeafa
                                    }))
                                    .px_4()
                                    .py_2()
                                    .text_color(rgb(if self.auto_update_enabled {
                                        0xffffff
                                    } else {
                                        0x29243a
                                    }))
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
                    .when_some(self.settings_status.clone(), |panel, status| {
                        panel.child(div().text_sm().text_color(rgb(0x5c4f8f)).child(status))
                    })
                    .child(
                        div()
                            .id("close-settings")
                            .cursor_pointer()
                            .rounded_lg()
                            .bg(rgb(0x5c4f8f))
                            .px_4()
                            .py_2()
                            .text_color(rgb(0xffffff))
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.screen {
            Screen::Home => self.render_home(cx).into_any_element(),
            Screen::AddStorage => self.render_add_storage(cx).into_any_element(),
            Screen::Browser => self.render_browser(cx).into_any_element(),
            Screen::Trash => self.render_trash(cx).into_any_element(),
            Screen::Settings => self.render_settings(cx).into_any_element(),
        };

        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0xf7f5ff))
            .text_color(rgb(0x29243a))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_6()
                    .py_4()
                    .border_b_1()
                    .border_color(rgb(0xe3def2))
                    .bg(rgb(0xffffff))
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Lopload"),
                    )
                    .child(
                        div()
                            .id("open-settings")
                            .cursor_pointer()
                            .rounded_lg()
                            .border_1()
                            .border_color(rgb(0xd4cee8))
                            .px_3()
                            .py_2()
                            .child("Settings")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.screen = Screen::Settings;
                                this.settings_status = None;
                                cx.notify();
                            })),
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

fn transfer_state_label(state: &TransferState) -> String {
    match state {
        TransferState::Queued => "Waiting".into(),
        TransferState::Sending { percent } => format!("Transferring… {percent:.0}%"),
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

fn main() {
    Application::new().run(|cx: &mut App| {
        gpui_component::init(cx);
        let bounds = Bounds::centered(None, size(px(1100.0), px(720.0)), cx);
        cx.open_window(
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
        cx.activate(true);
    });
}
