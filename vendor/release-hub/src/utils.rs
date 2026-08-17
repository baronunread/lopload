// Copyright (c) 2025 BibCiTeX Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// This file contains code derived from tauri-plugin-updater
// Original source: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater
// Copyright (c) 2015 - Present - The Tauri Programme within The Commons Conservancy.
// Licensed under MIT OR MIT/Apache-2.0

//! Filesystem path helpers used by the updater.

use crate::{Error, Result};
use std::path::{Path, PathBuf};

/// Bundle types supported by the installer logic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleType {
    /// macOS `.app.zip` bundle.
    MacOSAppZip,
    /// macOS DMG image.
    MacOSDMG,
    /// Windows MSI installer.
    WindowsMSI,
    /// Windows EXE / setup installer.
    WindowsSetUp,
}

/// Derive the target extract/installation path from the current executable path.
///
/// On macOS, this transforms `/Applications/App.app/Contents/MacOS/App`
/// into `/Applications/App.app`.
pub fn extract_path_from_executable(executable_path: &Path) -> Result<PathBuf> {
    // Return the path of the current executable by default
    // Example C:\Program Files\My App\
    let extract_path = executable_path
        .parent()
        .map(PathBuf::from)
        .ok_or(Error::FailedToDetermineExtractPath)?;

    // MacOS example binary is in /Applications/TestApp.app/Contents/MacOS/myApp
    // We need to get /Applications/<app>.app
    // TODO(lemarier): Need a better way here
    // Maybe we could search for <*.app> to get the right path
    #[cfg(target_os = "macos")]
    if extract_path
        .display()
        .to_string()
        .contains("Contents/MacOS")
    {
        use std::path::PathBuf;

        return extract_path
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath)?
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath);
    }

    Ok(extract_path)
}
