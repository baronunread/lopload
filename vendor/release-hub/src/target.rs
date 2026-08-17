//! Platform and installer target modeling.

use crate::{Error, Result};
use std::path::Path;

/// Supported operating systems for release targeting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OS {
    /// Linux targets.
    Linux,
    /// macOS / Darwin targets.
    Macos,
    /// Windows targets.
    Windows,
}

/// Supported CPU architectures for release targeting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Arch {
    /// 64-bit x86.
    X86_64,
    /// 64-bit ARM.
    Arm64,
}

/// Installer formats understood by the platform backends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallerKind {
    /// Linux AppImage package.
    AppImage,
    /// Debian package.
    Deb,
    /// RPM package.
    Rpm,
    /// macOS `.app.tar.gz` archive.
    AppTarGz,
    /// macOS `.app.zip` archive.
    AppZip,
    /// Windows MSI installer.
    Msi,
    /// Windows EXE / NSIS-style installer.
    Nsis,
}

/// Runtime platform information for target selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemInfo {
    /// Operating system component.
    pub os: OS,
    /// Architecture component.
    pub arch: Arch,
}

/// Fully-resolved target descriptor used for source selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetInfo {
    /// Canonical target string such as `linux-x86_64`.
    pub target: String,
    /// Structured system information used to derive the target.
    pub system: SystemInfo,
}

impl TargetInfo {
    /// Converts structured system information into the crate's canonical target string.
    ///
    /// For example, macOS on Apple Silicon becomes `darwin-aarch64`.
    pub fn from_system(system: SystemInfo) -> Self {
        let os = match system.os {
            OS::Linux => "linux",
            OS::Macos => "darwin",
            OS::Windows => "windows",
        };
        let arch = match system.arch {
            Arch::X86_64 => "x86_64",
            Arch::Arm64 => "aarch64",
        };
        Self {
            target: format!("{os}-{arch}"),
            system,
        }
    }
}

impl SystemInfo {
    /// Detects the current host operating system and architecture.
    ///
    /// Only the platform combinations supported by this crate are recognized.
    pub fn current() -> Result<Self> {
        let os = if cfg!(target_os = "linux") {
            OS::Linux
        } else if cfg!(target_os = "macos") {
            OS::Macos
        } else if cfg!(target_os = "windows") {
            OS::Windows
        } else {
            return Err(Error::UnsupportedOs);
        };
        let arch = if cfg!(target_arch = "x86_64") {
            Arch::X86_64
        } else if cfg!(target_arch = "aarch64") {
            Arch::Arm64
        } else {
            return Err(Error::UnsupportedArch);
        };
        Ok(Self { os, arch })
    }
}

impl InstallerKind {
    /// Infers the installer format from an artifact filename or path.
    ///
    /// Matching is based on the final filename suffix, such as `.AppImage`,
    /// `.app.tar.gz`, or `.msi`.
    pub fn from_path(path: &Path) -> Result<Self> {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if name.ends_with(".AppImage") {
            Ok(Self::AppImage)
        } else if name.ends_with(".deb") {
            Ok(Self::Deb)
        } else if name.ends_with(".rpm") {
            Ok(Self::Rpm)
        } else if name.ends_with(".app.tar.gz") {
            Ok(Self::AppTarGz)
        } else if name.ends_with(".app.zip") {
            Ok(Self::AppZip)
        } else if name.ends_with(".msi") {
            Ok(Self::Msi)
        } else if name.ends_with(".exe") {
            Ok(Self::Nsis)
        } else {
            Err(Error::InvalidUpdaterFormat)
        }
    }
}
