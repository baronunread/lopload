use dioxus::prelude::*;
use release_hub::{Config, GitHubSource, Update, UpdaterBuilder};
use std::{env, time::Duration};

const APP_NAME: &str = "MyDioxusApp";
const CURRENT_VERSION: &str = "1.0.0";
const GITHUB_OWNER: &str = "owner";
const GITHUB_REPO: &str = "repo";
const MINISIGN_PUBKEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Checking,
    ReadyToInstall,
    Installing,
    Finished,
    Error,
}

fn main() {
    dioxus::launch(App);
}

#[component]
fn App() -> Element {
    let phase = use_signal(|| Phase::Idle);
    let status = use_signal(|| {
        "Click \"Check for updates\" to query the latest GitHub release.".to_string()
    });
    let source_mode = use_signal(|| "anonymous GitHub API access".to_string());
    let downloaded_bytes = use_signal(|| 0usize);
    let pending_update = use_signal(|| Option::<Update>::None);

    let is_busy = matches!(phase(), Phase::Checking | Phase::Installing);

    rsx! {
        div { style: "font-family: sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;",

            h1 { "release-hub + Dioxus + GitHub Releases" }

            p {
                "This desktop example checks GitHub Releases, shows the available version, "
                "and downloads plus installs the update for the current platform."
            }

            div { style: "display: flex; gap: 0.75rem; margin: 1.5rem 0;",

                button {
                    disabled: is_busy,
                    onclick: move |_| {
                        let mut phase = phase;
                        let mut status = status;
                        let mut source_mode = source_mode;
                        let mut downloaded_bytes = downloaded_bytes;
                        let mut pending_update = pending_update;

                        spawn(async move {
                            phase.set(Phase::Checking);
                            downloaded_bytes.set(0);
                            pending_update.set(None);
                            status
                                .set(
                                    format!(
                                        "Checking GitHub releases for {GITHUB_OWNER}/{GITHUB_REPO}...",
                                    ),
                                );
                            match build_updater() {
                                Ok((updater, auth_mode)) => {
                                    source_mode.set(auth_mode);
                                    match updater.check().await {
                                        Ok(Some(update)) => {
                                            let next_version = update.version.clone();
                                            let notes = update
                                                .body
                                                .clone()
                                                .unwrap_or_else(|| {
                                                    "No release notes were provided.".to_string()
                                                });
                                            pending_update.set(Some(update));
                                            phase.set(Phase::ReadyToInstall);
                                            status
                                                .set(
                                                    format!("Update {next_version} is available. {notes}"),
                                                );
                                        }
                                        Ok(None) => {
                                            phase.set(Phase::Idle);
                                            status
                                                .set("You are already on the latest version.".to_string());
                                        }
                                        Err(error) => {
                                            phase.set(Phase::Error);
                                            status.set(format!("Update check failed: {error}"));
                                        }
                                    }
                                }
                                Err(error) => {
                                    phase.set(Phase::Error);
                                    status.set(format!("Updater configuration failed: {error}"));
                                }
                            }
                        });
                    },
                    "Check for updates"
                }

                {
                    match pending_update() {
                        Some(update) => rsx! {
                            button {
                                disabled: is_busy,
                                onclick: move |_| {
                                    let update = update.clone();
                                    let mut phase = phase;
                                    let mut status = status;
                                    let mut downloaded_bytes = downloaded_bytes;
                                    let mut pending_update = pending_update;

                                    spawn(async move {
                                        phase.set(Phase::Installing);
                                        downloaded_bytes.set(0);
                                        status.set(format!("Downloading and installing {}...", update.version));
                                        match update.download_and_install(|chunk| downloaded_bytes.set(chunk)).await
                                        {
                                            Ok(()) => {
                                                phase.set(Phase::Finished);
                                                pending_update.set(None);
                                                status
                                                    .set(
                                                        "Update installed. Restart the app to launch the new version."
                                                            .to_string(),
                                                    );
                                            }
                                            Err(error) => {
                                                phase.set(Phase::Error);
                                                status.set(format!("Install failed: {error}"));
                                            }
                                        }
                                    });
                                },
                                "Download and install"
                            }
                        },
                        None => rsx! {
                            Fragment {}
                        },
                    }
                }
            }

            p {
                strong { "Status: " }
                {status()}
            }

            p {
                strong { "GitHub mode: " }
                {source_mode()}
            }

            if matches!(phase(), Phase::Installing | Phase::Finished) {
                p {
                    strong { "Downloaded: " }
                    {format_bytes(downloaded_bytes())}
                }
            }

            if let Some(update) = pending_update() {
                div { style: "padding: 1rem; border: 1px solid #ddd; border-radius: 0.75rem; margin-top: 1rem;",

                    h2 { style: "margin-top: 0;", "Available release" }

                    p {
                        strong { "Current version: " }
                        {CURRENT_VERSION}
                    }

                    p {
                        strong { "Latest version: " }
                        {update.version.to_string()}
                    }

                    p {
                        strong { "Artifact URL: " }
                        {update.download_url.to_string()}
                    }

                    p {
                        strong { "Release notes: " }
                        {update.body.unwrap_or_else(|| "No release notes were provided.".to_string())}
                    }
                }
            }

            p { style: "margin-top: 1.5rem; color: #666;",
                "Set GITHUB_TOKEN to access private repositories or avoid anonymous rate limits. "
                "Replace the placeholder owner, repo, version, and minisign public key with your app's real values."
            }
        }
    }
}

fn build_updater() -> release_hub::Result<(release_hub::Updater, String)> {
    let config = Config {
        pubkey: MINISIGN_PUBKEY.into(),
        ..Default::default()
    };

    let token = env::var("GITHUB_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let (source, auth_mode): (GitHubSource, String) = match token {
        Some(token) => (
            GitHubSource::with_auth_token(GITHUB_OWNER, GITHUB_REPO, token)?,
            "authenticated with GITHUB_TOKEN".to_string(),
        ),
        None => (
            GitHubSource::new(GITHUB_OWNER, GITHUB_REPO),
            "anonymous GitHub API access".to_string(),
        ),
    };

    let updater = UpdaterBuilder::new(APP_NAME, CURRENT_VERSION, config)
        .source(Box::new(source))
        .timeout(Duration::from_secs(15))
        .build()?;

    Ok((updater, auth_mode))
}

fn format_bytes(bytes: usize) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;

    let bytes_f64 = bytes as f64;
    if bytes_f64 >= MIB {
        format!("{:.2} MiB", bytes_f64 / MIB)
    } else if bytes_f64 >= KIB {
        format!("{:.2} KiB", bytes_f64 / KIB)
    } else {
        format!("{bytes} B")
    }
}
