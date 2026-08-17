use gpui::{
    App, AppContext, Application, Bounds, Context, Entity, FontWeight, Render, Window,
    WindowBounds, WindowOptions, div, prelude::*, px, rgb, size,
};
use gpui_component::{
    Root,
    input::{Input, InputState},
    scroll::ScrollableElement,
};
use lopload_native::{
    NewStorageConnection, StorageConnection, delete_connection, list_connections,
    s3::{RemoteEntry, RemoteEntryKind, create_folder as create_remote_folder, list_entries},
    save_connection, set_last_prefix,
};

#[derive(Clone, Copy)]
enum Screen {
    Home,
    AddStorage,
    Browser,
}

enum BrowserStatus {
    Idle,
    Loading,
    Failed(String),
}

struct LoploadApp {
    screen: Screen,
    connections: Vec<StorageConnection>,
    current_connection: Option<StorageConnection>,
    prefix: String,
    entries: Vec<RemoteEntry>,
    browser_status: BrowserStatus,
    load_generation: u64,
    name: Entity<InputState>,
    endpoint: Entity<InputState>,
    bucket: Entity<InputState>,
    region: Entity<InputState>,
    access_key: Entity<InputState>,
    secret_key: Entity<InputState>,
    folder_name: Entity<InputState>,
    form_error: Option<String>,
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
        Self {
            screen: Screen::Home,
            connections,
            current_connection: None,
            prefix: String::new(),
            entries: Vec::new(),
            browser_status: BrowserStatus::Idle,
            load_generation: 0,
            name: cx.new(|cx| InputState::new(window, cx).placeholder("My storage")),
            endpoint: cx
                .new(|cx| InputState::new(window, cx).placeholder("https://storage.example.com")),
            bucket: cx.new(|cx| InputState::new(window, cx).placeholder("Bucket name")),
            region: cx.new(|cx| InputState::new(window, cx).placeholder("auto")),
            access_key: cx.new(|cx| InputState::new(window, cx).placeholder("Access key")),
            secret_key: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("Secret key")
                    .masked(true)
            }),
            folder_name: cx.new(|cx| InputState::new(window, cx).placeholder("Folder name")),
            form_error: None,
            folder_error: None,
            new_folder_open: false,
            home_error,
        }
    }

    fn open_connection(&mut self, connection: StorageConnection, cx: &mut Context<Self>) {
        let prefix = connection.last_prefix.clone();
        self.current_connection = Some(connection);
        self.screen = Screen::Browser;
        self.load_prefix(prefix, cx);
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
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.screen = Screen::AddStorage;
                            cx.notify();
                        })),
                ),
        )
    }

    fn render_add_storage(&self, cx: &mut Context<Self>) -> impl IntoElement {
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
                            .child("Add storage"),
                    )
                    .child(
                        div()
                            .text_color(rgb(0x766d91))
                            .child("Connection details stay in the app database. Credentials go directly to your OS keychain."),
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
                                    .id("save-storage")
                                    .cursor_pointer()
                                    .rounded_lg()
                                    .bg(rgb(0x5c4f8f))
                                    .px_4()
                                    .py_2()
                                    .text_color(rgb(0xffffff))
                                    .child("Save storage")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        let input = NewStorageConnection {
                                            name: this.name.read(cx).value().to_string(),
                                            endpoint: this.endpoint.read(cx).value().to_string(),
                                            bucket: this.bucket.read(cx).value().to_string(),
                                            region: this.region.read(cx).value().to_string(),
                                            access_key: this.access_key.read(cx).value().to_string(),
                                            secret_key: this.secret_key.read(cx).value().to_string(),
                                        };
                                        match save_connection(input) {
                                            Ok(connection) => {
                                                this.connections.push(connection.clone());
                                                this.form_error = None;
                                                this.access_key.update(cx, |input, cx| {
                                                    input.set_value("", window, cx)
                                                });
                                                this.secret_key.update(cx, |input, cx| {
                                                    input.set_value("", window, cx)
                                                });
                                                this.open_connection(connection, cx);
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
                            .when(folder, |row| {
                                row.on_click(cx.listener(move |this, _, _, cx| {
                                    this.load_prefix(key.clone(), cx);
                                }))
                            })
                    })),
            )
    }
}

impl Render for LoploadApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.screen {
            Screen::Home => self.render_home(cx).into_any_element(),
            Screen::AddStorage => self.render_add_storage(cx).into_any_element(),
            Screen::Browser => self.render_browser(cx).into_any_element(),
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
                            .text_sm()
                            .text_color(rgb(0x766d91))
                            .child("Native GPUI"),
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
