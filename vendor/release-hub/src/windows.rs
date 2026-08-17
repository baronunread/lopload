// Copyright (c) 2025 BibCiTeX Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// This file contains code derived from tauri-plugin-updater
// Original source: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater
// Copyright (c) 2015 - Present - The Tauri Programme within The Commons Conservancy.
// Licensed under MIT OR MIT/Apache-2.0

use crate::{Error, Result, Update, Updater, builder::windows_installer_args_command_line};
use fs_err as fs;
use semver::Version;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;
use windows::core::{HSTRING, PCWSTR, w};

type WindowsUpdaterType = (PathBuf, Option<tempfile::TempPath>);
static UPDATER_FILE: OnceLock<OsString> = OnceLock::new();
static TEMP_FILE_KEEPER: Mutex<Option<tempfile::TempPath>> = Mutex::new(None);

impl Update {
    pub(crate) fn install_windows(&self, bytes: &[u8]) -> Result<()> {
        launch_windows_installer(bytes, &self.app_name, &self.version, &self.installer_args)
    }
}

impl Updater {
    pub(crate) fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        launch_windows_installer(
            bytes,
            &self.app_name,
            &self.current_version,
            &self.installer_args,
        )
    }

    pub(crate) fn relaunch_inner(&self) -> Result<()> {
        relaunch_windows(&self.installer_args)
    }
}

fn install_windows_with_label(bytes: &[u8], app_name: &str, version: &Version) -> Result<()> {
    let (temp_path, temp_keeper) = extract_exe(bytes, app_name, version)?;

    if !temp_path.exists() {
        return Err(Error::InvalidUpdaterFormat);
    }

    *TEMP_FILE_KEEPER.lock().unwrap() = temp_keeper;

    let file = temp_path.as_os_str().to_os_string();
    UPDATER_FILE
        .set(file)
        .map_err(|_| Error::InvalidUpdaterFormat)?;

    Ok(())
}

fn launch_windows_installer(
    bytes: &[u8],
    app_name: &str,
    version: &Version,
    installer_args: &[OsString],
) -> Result<()> {
    install_windows_with_label(bytes, app_name, version)?;
    relaunch_windows(installer_args)
}

fn relaunch_windows(installer_args: &[OsString]) -> Result<()> {
    let file = UPDATER_FILE.get().ok_or(Error::InvalidUpdaterFormat)?;

    if !Path::new(file).exists() {
        return Err(Error::InvalidUpdaterFormat);
    }

    let file_hstring: HSTRING = file.clone().into();
    let installer_args = windows_installer_args_command_line(installer_args);
    let installer_args_hstring = installer_args.as_ref().map(HSTRING::from);
    let installer_args = installer_args_hstring.as_ref();
    let result = unsafe {
        ShellExecuteW(
            Some(HWND::default()),
            w!("runas"),
            &file_hstring,
            installer_args
                .map(|args| PCWSTR(args.as_ptr()))
                .unwrap_or(w!("")),
            w!("."),
            SW_SHOW,
        )
    }
    .0 as i32;

    if result <= 32 {
        *TEMP_FILE_KEEPER.lock().unwrap() = None;
        return match result {
            2 => Err(crate::Error::InvalidUpdaterFormat),
            5 => Err(crate::Error::InsufficientPrivileges),
            32 => Err(crate::Error::FileInUse),
            1223 => Err(crate::Error::UserCancelledElevation),
            _ => Err(crate::Error::InstallerExecutionFailed(result)),
        };
    }

    *TEMP_FILE_KEEPER.lock().unwrap() = None;
    thread::sleep(Duration::from_millis(500));
    std::process::exit(0);
}

fn make_temp_dir(app_name: &str, version: &Version) -> Result<PathBuf> {
    let temp_dir = tempfile::Builder::new()
        .prefix(&format!("{app_name}-{version}-updater-"))
        .tempdir();

    match temp_dir {
        Ok(dir) => {
            let path = dir.keep();
            if path.exists() && path.is_dir() {
                Ok(path)
            } else {
                Err(crate::Error::TempDirNotFound)
            }
        }
        Err(_) => {
            let fallback_dir =
                std::env::current_dir()?.join(format!("{app_name}-{version}-updater-temp"));

            fs::create_dir_all(&fallback_dir)?;
            Ok(fallback_dir)
        }
    }
}

fn extract_exe(bytes: &[u8], app_name: &str, version: &Version) -> Result<WindowsUpdaterType> {
    let (path, temp) = write_to_temp(bytes, app_name, version, ".exe")?;
    Ok((path, temp))
}

fn write_to_temp(
    bytes: &[u8],
    app_name: &str,
    version: &Version,
    ext: &str,
) -> Result<(PathBuf, Option<tempfile::TempPath>)> {
    use std::io::Write;

    let temp_dir = make_temp_dir(app_name, version)?;
    let mut temp_file = tempfile::Builder::new()
        .prefix(&format!("{app_name}-{version}-installer"))
        .suffix(ext)
        .rand_bytes(0)
        .tempfile_in(&temp_dir)?;

    temp_file.write_all(bytes)?;
    temp_file.flush()?;

    let temp = temp_file.into_temp_path();
    let temp_path = temp.to_path_buf();

    if !temp_path.exists() || fs::metadata(&temp_path)?.len() != bytes.len() as u64 {
        return Err(crate::Error::InvalidUpdaterFormat);
    }

    Ok((temp_path, Some(temp)))
}
