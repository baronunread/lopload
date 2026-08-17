#![doc = include_str!("../README.md")]

// Copyright (c) 2015 - Present - The Tauri Programme within The Commons Conservancy.
//
// License: Apache-2.0 OR MIT/Apache-2.0
//
// Modified by tangxiangong (2025) for [release-hub](https://github.com/tangxiangong/release-hub).
//
// # Note
//
// This crate is forked and modified from the [tauri-apps/tauri-plugin-updater](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater), which is licensed under [MIT](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/LICENSE_MIT) or [Apache 2.0](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/LICENSE_APACHE-2.0)/[MIT](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/LICENSE_MIT).

mod builder;
pub use builder::{Updater, UpdaterBuilder, VersionComparator};
mod config;
pub use config::*;
mod error;
pub use error::*;
mod linux;
pub use linux::LinuxInstallCommand;
mod verify;
pub use verify::*;
/// Release source implementations and the source abstraction used by the updater.
pub mod source;
pub use source::*;
mod target;
pub use target::*;
mod release;
pub use release::{ReleaseManifestPlatform, RemoteRelease, RemoteReleaseInner, Update};
#[cfg(target_os = "macos")]
/// macOS installation and relaunch implementation.
///
/// Handles extracting `.app.zip` bundles, atomically swapping the installed
/// application, and elevating privileges through AppleScript when necessary.
mod macos;
#[cfg(target_os = "windows")]
/// Windows installation and relaunch implementation.
///
/// Writes the downloaded installer to a temporary location and launches it with
/// elevation using `ShellExecuteW` and the `runas` verb. Handles common error
/// cases like access denied or user-cancelled elevation.
mod windows;
pub use source::github::GitHubSource;
mod utils;
pub use utils::{BundleType, extract_path_from_executable};
