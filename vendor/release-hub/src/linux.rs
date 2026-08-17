//! Linux-specific installation helpers.

use crate::{Error, InstallerKind, Result, Update};
use fs_err as fs;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

/// Linux command description for package-manager-backed installs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxInstallCommand {
    /// Executable to launch.
    pub program: String,
    /// Arguments passed to the executable.
    pub args: Vec<String>,
}

impl LinuxInstallCommand {
    /// Builds the Linux install command for a staged artifact.
    ///
    /// `.deb` and `.rpm` artifacts are installed through `pkexec`, while
    /// AppImages are staged through `install` before the final atomic swap.
    pub fn for_kind(kind: InstallerKind, artifact: PathBuf) -> Result<Self> {
        let path = artifact.display().to_string();
        match kind {
            InstallerKind::AppImage => Ok(Self {
                program: "install".into(),
                args: vec![
                    "-m".into(),
                    "755".into(),
                    path.clone(),
                    format!("{path}.new"),
                ],
            }),
            InstallerKind::Deb => Ok(Self {
                program: "pkexec".into(),
                args: vec!["dpkg".into(), "-i".into(), path],
            }),
            InstallerKind::Rpm => Ok(Self {
                program: "pkexec".into(),
                args: vec!["rpm".into(), "-U".into(), path],
            }),
            _ => unreachable!("non-linux installer kind"),
        }
    }
}

impl Update {
    pub(crate) fn install_linux(&self, bytes: &[u8]) -> Result<()> {
        if self.installer_kind == InstallerKind::AppImage {
            return install_appimage(bytes, &self.extract_path);
        }

        let staging_dir = tempfile::Builder::new()
            .prefix("release-hub-linux-installer-")
            .tempdir()?;
        let artifact_name = self
            .download_url
            .path_segments()
            .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
            .unwrap_or("release-hub-installer.bin");
        let artifact_path = staging_dir.path().join(artifact_name);

        fs::write(&artifact_path, bytes)?;

        let command = LinuxInstallCommand::for_kind(self.installer_kind.clone(), artifact_path)?;
        let status = Command::new(&command.program)
            .args(&command.args)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(Error::InstallerExecutionFailed(status.code().unwrap_or(-1)))
        }
    }
}

fn install_appimage(bytes: &[u8], target_path: &Path) -> Result<()> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let staging_path = appimage_staging_path(target_path);
    fs::write(&staging_path, bytes)?;
    #[cfg(unix)]
    {
        use std::{fs::Permissions, os::unix::fs::PermissionsExt};

        fs::set_permissions(&staging_path, Permissions::from_mode(0o755))?;
    }
    fs::rename(&staging_path, target_path)?;
    Ok(())
}

fn appimage_staging_path(target_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.new", target_path.display()))
}
