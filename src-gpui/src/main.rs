use gpui::{
    App, AppContext, Application, Bounds, Context, Entity, FontWeight, Render, Window,
    WindowBounds, WindowOptions, div, prelude::*, px, rgb, size,
};
use gpui_component::{
    Root,
    input::{Input, InputState},
};
use lopload_native::{NewStorageConnection, StorageConnection, list_connections, save_connection};

#[derive(Clone, Copy)]
enum Screen {
    Home,
    AddStorage,
}

struct LoploadApp {
    screen: Screen,
    connections: Vec<StorageConnection>,
    name: Entity<InputState>,
    endpoint: Entity<InputState>,
    region: Entity<InputState>,
    access_key: Entity<InputState>,
    secret_key: Entity<InputState>,
    form_error: Option<String>,
}

impl LoploadApp {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let connections = list_connections().unwrap_or_default();
        Self {
            screen: Screen::Home,
            connections,
            name: cx.new(|cx| InputState::new(window, cx).placeholder("My storage")),
            endpoint: cx
                .new(|cx| InputState::new(window, cx).placeholder("https://storage.example.com")),
            region: cx.new(|cx| InputState::new(window, cx).placeholder("auto")),
            access_key: cx.new(|cx| InputState::new(window, cx).placeholder("Access key")),
            secret_key: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("Secret key")
                    .masked(true)
            }),
            form_error: None,
        }
    }
}

impl Render for LoploadApp {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.screen {
            Screen::Home => div()
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
                        .w(px(480.0))
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
                                .child("Your storage, natively"),
                        )
                        .child(
                            div()
                                .text_center()
                                .text_color(rgb(0x766d91))
                                .child(format!(
                                    "{} storage connection{} saved without a webview.",
                                    self.connections.len(),
                                    if self.connections.len() == 1 { "" } else { "s" }
                                )),
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
                ),
            Screen::AddStorage => div()
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
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(div().text_sm().child("Name"))
                                .child(Input::new(&self.name).w_full()),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(div().text_sm().child("Endpoint"))
                                .child(Input::new(&self.endpoint).w_full()),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(div().text_sm().child("Region"))
                                .child(Input::new(&self.region).w_full()),
                        )
                        .child(
                            div()
                                .flex()
                                .gap_3()
                                .child(
                                    div()
                                        .flex_1()
                                        .flex()
                                        .flex_col()
                                        .gap_2()
                                        .child(div().text_sm().child("Access key"))
                                        .child(Input::new(&self.access_key).w_full()),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .flex()
                                        .flex_col()
                                        .gap_2()
                                        .child(div().text_sm().child("Secret key"))
                                        .child(Input::new(&self.secret_key).w_full()),
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
                                                region: this.region.read(cx).value().to_string(),
                                                access_key: this.access_key.read(cx).value().to_string(),
                                                secret_key: this.secret_key.read(cx).value().to_string(),
                                            };
                                            match save_connection(input) {
                                                Ok(connection) => {
                                                    this.connections.push(connection);
                                                    this.screen = Screen::Home;
                                                    this.form_error = None;
                                                    this.access_key.update(cx, |input, cx| {
                                                        input.set_value("", window, cx)
                                                    });
                                                    this.secret_key.update(cx, |input, cx| {
                                                        input.set_value("", window, cx)
                                                    });
                                                }
                                                Err(error) => this.form_error = Some(error),
                                            }
                                            cx.notify();
                                        })),
                                ),
                        ),
                ),
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
                            .child("Experimental GPUI build"),
                    ),
            )
            .child(content)
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
