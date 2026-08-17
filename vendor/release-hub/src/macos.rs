// Copyright (c) 2025 BibCiTeX Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// This file contains code derived from tauri-plugin-updater
// Original source: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater
// Copyright (c) 2015 - Present - The Tauri Programme within The Commons Conservancy.
// Licensed under MIT OR MIT/Apache-2.0

use crate::{Error, Result, Update, Updater};
use fs_err as fs;
use osakit::{Language, Script};
use std::{
    fs::Permissions,
    io::Cursor,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use zip::ZipArchive;

impl Update {
    pub(crate) fn install_macos(&self, bytes: &[u8]) -> Result<()> {
        install_macos_at(&self.extract_path, bytes)
    }
}

impl Updater {
    pub(crate) fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        install_macos_at(&self.extract_path, bytes)
    }

    pub(crate) fn relaunch_inner(&self) -> Result<()> {
        relaunch_macos_at(&self.extract_path)
    }
}

fn extract_zip(bytes: &[u8], extract_path: &Path) -> Result<Vec<PathBuf>> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    let mut extracted_files = Vec::new();

    let tmp_extract_dir = tempfile::Builder::new()
        .prefix("rust_updated_app")
        .tempdir()?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = match file.enclosed_name() {
            Some(path) => tmp_extract_dir.path().join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            fs::create_dir_all(&outpath)?;
            if let Some(mode) = file.unix_mode() {
                let permissions = Permissions::from_mode(mode);
                fs::set_permissions(&outpath, permissions)?;
            }
        } else {
            if let Some(parent) = outpath.parent()
                && !parent.exists()
            {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;

            if let Some(mode) = file.unix_mode() {
                let permissions = Permissions::from_mode(mode);
                fs::set_permissions(&outpath, permissions)?;
            } else {
                let file_name = outpath
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                let path_str = outpath.to_string_lossy();
                if path_str.contains("Contents/MacOS/")
                    || (!file_name.contains('.') && !path_str.contains("Contents/Resources/"))
                {
                    fs::set_permissions(&outpath, Permissions::from_mode(0o755))?;
                }
            }
        }
        extracted_files.push(outpath);
    }

    let app_bundle = extracted_files
        .iter()
        .find(|path| path.extension().and_then(|s| s.to_str()) == Some("app"))
        .cloned();

    if let Some(app_path) = app_bundle {
        move_app_bundle(&app_path, extract_path)?;
    } else {
        move_extracted_files(tmp_extract_dir.path(), extract_path)?;
    }

    Ok(extracted_files)
}

fn move_app_bundle(app_path: &Path, extract_path: &Path) -> Result<()> {
    let tmp_backup_dir = tempfile::Builder::new()
        .prefix("tauri_current_app")
        .tempdir()?;

    let move_result = fs::rename(extract_path, tmp_backup_dir.path().join("current_app"));

    let need_authorization = if let Err(err) = move_result {
        if err.kind() == std::io::ErrorKind::PermissionDenied {
            true
        } else {
            return Err(err.into());
        }
    } else {
        false
    };

    if need_authorization {
        let backup_path = format!("{}.backup", extract_path.display());
        let apple_script = format!(
            "do shell script \"mv '{src}' '{backup}' && mv '{new}' '{src}' && rm -rf '{backup}'\" with administrator privileges",
            src = extract_path.display(),
            new = app_path.display(),
            backup = backup_path
        );

        let mut script = Script::new_from_source(Language::AppleScript, &apple_script);
        script.compile().expect("invalid AppleScript");
        let result = script.execute();

        if result.is_err() {
            let restore_script = format!(
                "do shell script \"if [ -d '{backup}' ]; then rm -rf '{src}' && mv '{backup}' '{src}'; fi\" with administrator privileges",
                src = extract_path.display(),
                backup = backup_path
            );
            let mut restore_script =
                Script::new_from_source(Language::AppleScript, &restore_script);
            restore_script.compile().expect("invalid AppleScript");
            let _ = restore_script.execute();

            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Failed to move the new app into place",
            )));
        }
    } else {
        let backup_path = extract_path.with_extension("backup");

        if extract_path.exists() {
            fs::rename(extract_path, &backup_path)?;
        }

        if let Err(err) = fs::rename(app_path, extract_path) {
            if backup_path.exists() {
                let _ = fs::rename(&backup_path, extract_path);
            }
            return Err(err.into());
        }

        if backup_path.exists() {
            let _ = fs::remove_dir_all(&backup_path);
        }
    }

    Ok(())
}

fn move_extracted_files(extract_dir: &Path, extract_path: &Path) -> Result<()> {
    let tmp_backup_dir = tempfile::Builder::new()
        .prefix("rust_current_app")
        .tempdir()?;

    let move_result = fs::rename(extract_path, tmp_backup_dir.path().join("current_app"));

    let need_authorization = if let Err(err) = move_result {
        if err.kind() == std::io::ErrorKind::PermissionDenied {
            true
        } else {
            return Err(err.into());
        }
    } else {
        false
    };

    if need_authorization {
        let apple_script = format!(
            "do shell script \"rm -rf '{src}' && mv -f '{new}' '{src}'\" with administrator privileges",
            src = extract_path.display(),
            new = extract_dir.display()
        );

        let mut script = Script::new_from_source(Language::AppleScript, &apple_script);
        script.compile().expect("invalid AppleScript");
        let result = script.execute();

        if result.is_err() {
            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Failed to move the new app into place",
            )));
        }
    } else {
        if extract_path.exists() {
            fs::remove_dir_all(extract_path)?;
        }
        fs::rename(extract_dir, extract_path)?;
    }

    Ok(())
}

fn install_macos_at(extract_path: &Path, bytes: &[u8]) -> Result<()> {
    extract_zip(bytes, extract_path)?;
    let _ = Command::new("touch").arg(extract_path).status()?;
    Ok(())
}

fn relaunch_macos_at(extract_path: &Path) -> Result<()> {
    let _ = Command::new("open").arg("-n").arg(extract_path).spawn()?;
    std::process::exit(0);
}
