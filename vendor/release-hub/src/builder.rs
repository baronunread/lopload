//! Builder and runtime updater APIs.

// Copyright (c) 2025 BibCiTeX Contributors
// SPDX-License-Identifier: MIT OR Apache-2.0
//
// This file contains code derived from tauri-plugin-updater
// Original source: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater
// Copyright (c) 2015 - Present - The Tauri Programme within The Commons Conservancy.
// Licensed under MIT OR MIT/Apache-2.0

use crate::{
    Config, EndpointSource, Error, InstallerKind, ReleaseSource, Result, SourceRequest, TargetInfo,
    Update, extract_path_from_executable,
};
use http::header::ACCEPT;
use http::{
    HeaderName,
    header::{HeaderMap, HeaderValue},
};
use reqwest::ClientBuilder;
use semver::Version;
use std::{
    env::current_exe,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use url::Url;

const UPDATER_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"),);

/// Custom version comparator used to override the default semver `>` update check.
///
/// The closure receives the current application version and the fetched remote
/// release model. Return `true` to treat the release as an update.
pub type VersionComparator =
    Arc<dyn Fn(Version, crate::RemoteRelease) -> bool + Send + Sync + 'static>;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_installer_args_command_line(args: &[OsString]) -> Option<String> {
    if args.is_empty() {
        None
    } else {
        Some(
            args.iter()
                .map(windows_quote_installer_arg)
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_quote_installer_arg(arg: &OsString) -> String {
    let arg = arg.to_string_lossy();
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.into_owned();
    }

    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(ch);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallAction {
    MacosArchive,
    WindowsExecutableLaunch,
    LinuxAppImageReplace,
    LinuxPackageCommand,
}

/// Configures and creates an [`Updater`].
///
/// This builder is the main integration point for application code. It merges
/// static [`Config`] values with per-instance overrides such as a custom
/// [`ReleaseSource`], request headers, proxy settings, and installer arguments.
pub struct UpdaterBuilder {
    app_name: String,
    current_version: Version,
    config: Config,
    target: Option<String>,
    source: Option<Box<dyn ReleaseSource>>,
    headers: HeaderMap,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    executable_path: Option<PathBuf>,
    installer_args: Vec<OsString>,
    version_comparator: Option<VersionComparator>,
}

impl UpdaterBuilder {
    /// Creates a new updater builder from application metadata and static configuration.
    ///
    /// `current_version` must be a valid semantic version string.
    pub fn new(app_name: &str, current_version: &str, config: Config) -> Self {
        Self {
            app_name: app_name.to_owned(),
            current_version: Version::parse(current_version).expect("valid semver"),
            config,
            target: None,
            source: None,
            headers: HeaderMap::new(),
            timeout: None,
            proxy: None,
            no_proxy: false,
            executable_path: None,
            installer_args: Vec::new(),
            version_comparator: None,
        }
    }

    /// Overrides the detected target string used when fetching release metadata.
    ///
    /// Target strings usually look like `linux-x86_64` or `darwin-aarch64`.
    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    /// Sets a custom release source implementation.
    ///
    /// When omitted, the builder falls back to [`EndpointSource`] using
    /// [`Config::endpoints`].
    pub fn source(mut self, source: Box<dyn ReleaseSource>) -> Self {
        self.source = Some(source);
        self
    }

    /// Overrides the default version comparison logic.
    ///
    /// By default, `release-hub` treats `remote.version > current_version` as
    /// an update. Provide a comparator here when you need custom channels or
    /// policies.
    pub fn version_comparator<F>(mut self, comparator: F) -> Self
    where
        F: Fn(Version, crate::RemoteRelease) -> bool + Send + Sync + 'static,
    {
        self.version_comparator = Some(Arc::new(comparator));
        self
    }

    /// Overrides the executable path used to derive the install target.
    pub fn executable_path<P: AsRef<Path>>(mut self, p: P) -> Self {
        self.executable_path.replace(p.as_ref().into());
        self
    }

    /// Adds a single HTTP header to release-fetch and download requests.
    pub fn header<K, V>(mut self, key: K, value: V) -> Result<Self>
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        let key: std::result::Result<HeaderName, http::Error> = key.try_into().map_err(Into::into);
        let value: std::result::Result<HeaderValue, http::Error> =
            value.try_into().map_err(Into::into);
        self.headers.insert(key?, value?);
        Ok(self)
    }

    /// Replaces all configured HTTP headers.
    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    /// Removes all configured HTTP headers.
    pub fn clear_headers(mut self) -> Self {
        self.headers.clear();
        self
    }

    /// Sets a timeout for release-fetch and download HTTP requests.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Configures a proxy for release-fetch and download requests.
    pub fn proxy(mut self, proxy: Url) -> Self {
        self.proxy = Some(proxy);
        self
    }

    /// Disables proxy usage for release-fetch and download requests.
    pub fn no_proxy(mut self) -> Self {
        self.no_proxy = true;
        self
    }

    /// Appends a single Windows installer argument.
    pub fn installer_arg<S>(mut self, arg: S) -> Self
    where
        S: Into<OsString>,
    {
        self.installer_args.push(arg.into());
        self
    }

    /// Appends multiple Windows installer arguments.
    pub fn installer_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.installer_args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Clears builder-provided Windows installer arguments.
    pub fn clear_installer_args(mut self) -> Self {
        self.installer_args.clear();
        self
    }

    /// Builds an [`Updater`] from the accumulated configuration.
    ///
    /// This validates the static config, resolves the effective target and
    /// install path, and materializes either the custom release source or the
    /// default endpoint-backed source.
    pub fn build(self) -> Result<Updater> {
        self.config.validate()?;

        if self.source.is_none() && self.config.endpoints.is_empty() {
            return Err(Error::Network("no endpoints configured".into()));
        }

        let target = match self.target {
            Some(target) => target,
            None => TargetInfo::from_system(crate::SystemInfo::current()?).target,
        };
        let source = match self.source {
            Some(source) => Arc::<dyn ReleaseSource>::from(source),
            None => Arc::new(EndpointSource::new(self.config.endpoints.clone())),
        };

        let executable_path = self.executable_path.unwrap_or(current_exe()?);
        let extract_path = if cfg!(target_os = "linux") {
            executable_path
        } else {
            extract_path_from_executable(&executable_path)?
        };
        let mut installer_args = self
            .config
            .windows
            .as_ref()
            .map(|windows| windows.installer_args.clone())
            .unwrap_or_default();
        installer_args.extend(self.installer_args);

        Ok(Updater {
            app_name: self.app_name,
            current_version: self.current_version,
            config: self.config,
            target,
            source,
            headers: self.headers,
            timeout: self.timeout,
            proxy: self.proxy,
            no_proxy: self.no_proxy,
            extract_path,
            installer_args,
            version_comparator: self.version_comparator,
            latest_release_version: Mutex::new(None),
        })
    }
}

/// Updater instance capable of checking, downloading and installing updates.
///
/// Instances are cheap to reuse and keep the last successfully observed remote
/// version for introspection through [`Self::latest_version`].
pub struct Updater {
    /// Application name used by platform backends and staging paths.
    pub app_name: String,
    /// Current application version.
    pub current_version: Version,
    /// Static updater configuration.
    pub config: Config,
    /// Selected target string.
    pub target: String,
    source: Arc<dyn ReleaseSource>,
    /// HTTP headers propagated to update downloads.
    pub headers: HeaderMap,
    /// Optional download timeout.
    pub timeout: Option<Duration>,
    /// Optional proxy configuration.
    pub proxy: Option<Url>,
    /// Whether proxy configuration should be ignored.
    pub no_proxy: bool,
    /// Derived installation target path.
    pub extract_path: PathBuf,
    /// Windows installer arguments propagated from config and builder overrides.
    pub installer_args: Vec<OsString>,
    /// Optional custom version comparator.
    pub version_comparator: Option<VersionComparator>,
    latest_release_version: Mutex<Option<Version>>,
}

impl Updater {
    /// Returns the latest remote version observed by the last successful [`Self::check`] call.
    pub fn latest_version(&self) -> Option<Version> {
        self.latest_release_version.lock().ok()?.clone()
    }

    /// Fetches release metadata and returns an [`Update`] when a newer version is available.
    ///
    /// The returned [`Update`] is already narrowed to the current target and
    /// contains the resolved installer URL, signature, and install strategy.
    pub async fn check(&self) -> Result<Option<Update>> {
        let request = SourceRequest::new(self.target.clone());
        let release = self.source.fetch(&request).await?;
        let mut headers = release.download_headers.clone();
        headers.extend(self.headers.clone());
        if let Ok(mut latest_release_version) = self.latest_release_version.lock() {
            *latest_release_version = Some(release.version.clone());
        }

        let has_update = if let Some(comparator) = &self.version_comparator {
            comparator(self.current_version.clone(), release.clone())
        } else {
            release.version > self.current_version
        };
        if !has_update {
            return Ok(None);
        }

        Ok(Some(Update {
            current_version: self.current_version.clone(),
            version: release.version.clone(),
            date: release.pub_date,
            body: release.notes.clone(),
            raw_json: serde_json::to_value(&release)?,
            download_url: release.download_url(&self.target)?.clone(),
            signature: release.signature(&self.target)?.clone(),
            pubkey: self.config.pubkey.clone(),
            target: self.target.clone(),
            installer_kind: InstallerKind::from_path(Path::new(
                release.download_url(&self.target)?.path(),
            ))?,
            headers,
            timeout: self.timeout,
            proxy: self.proxy.clone(),
            no_proxy: self.no_proxy,
            dangerous_accept_invalid_certs: self.config.dangerous_accept_invalid_certs,
            dangerous_accept_invalid_hostnames: self.config.dangerous_accept_invalid_hostnames,
            extract_path: self.extract_path.clone(),
            app_name: self.app_name.clone(),
            installer_args: self.installer_args.clone(),
        }))
    }

    /// Convenience helper that checks for an update and downloads/installs it when present.
    ///
    /// Returns `Ok(true)` when an update was found and installed, or `Ok(false)`
    /// when the current version is already up to date.
    pub async fn update<C: FnMut(usize)>(&self, on_chunk: C) -> Result<bool> {
        if let Some(update) = self.check().await? {
            update.download_and_install(on_chunk).await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Downloads the updater package for an [`Update`] and returns it as bytes.
    pub async fn download<C: FnMut(usize)>(&self, update: &Update, on_chunk: C) -> Result<Vec<u8>> {
        update.download(on_chunk).await
    }

    /// Installs artifact bytes previously returned by [`Updater::download`].
    pub fn install(&self, bytes: impl AsRef<[u8]>) -> Result<()> {
        self.install_inner(bytes.as_ref())
    }

    /// Relaunches the application using the current platform backend.
    ///
    /// Relaunch support is currently implemented on macOS and Windows.
    pub fn relaunch(&self) -> Result<()> {
        self.relaunch_inner()
    }

    /// Convenience helper that downloads and installs a specific [`Update`].
    pub async fn download_and_install<C: FnMut(usize)>(
        &self,
        update: &Update,
        on_chunk: C,
    ) -> Result<()> {
        update.download_and_install(on_chunk).await
    }
}

impl Update {
    fn install_action(&self) -> InstallAction {
        match self.installer_kind {
            InstallerKind::AppTarGz | InstallerKind::AppZip => InstallAction::MacosArchive,
            InstallerKind::Msi | InstallerKind::Nsis => InstallAction::WindowsExecutableLaunch,
            InstallerKind::AppImage => InstallAction::LinuxAppImageReplace,
            InstallerKind::Deb | InstallerKind::Rpm => InstallAction::LinuxPackageCommand,
        }
    }

    /// Downloads the selected artifact and verifies its detached minisign signature.
    ///
    /// The chunk callback receives the total number of bytes currently fetched
    /// for this download operation.
    pub async fn download<C>(&self, mut on_chunk: C) -> Result<Vec<u8>>
    where
        C: FnMut(usize),
    {
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        }

        let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
        if self.dangerous_accept_invalid_certs {
            request = request.danger_accept_invalid_certs(true);
        }
        if self.dangerous_accept_invalid_hostnames {
            request = request.danger_accept_invalid_hostnames(true);
        }
        if let Some(timeout) = self.timeout {
            request = request.timeout(timeout);
        }
        if self.no_proxy {
            request = request.no_proxy();
        } else if let Some(ref proxy) = self.proxy {
            let proxy = reqwest::Proxy::all(proxy.as_str())?;
            request = request.proxy(proxy);
        }

        let response = request
            .build()?
            .get(self.download_url.clone())
            .headers(headers)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(Error::Network(format!(
                "Download request failed with status: {}",
                response.status()
            )));
        }

        let bytes = response.bytes().await?;
        on_chunk(bytes.len());
        crate::verify_minisign(&bytes, &self.pubkey, &self.signature)?;
        Ok(bytes.to_vec())
    }

    /// Installs already-downloaded artifact bytes using the selected platform backend.
    pub fn install(&self, bytes: &[u8]) -> Result<()> {
        match self.install_action() {
            InstallAction::MacosArchive => self.install_macos(bytes),
            InstallAction::WindowsExecutableLaunch => self.install_windows(bytes),
            InstallAction::LinuxAppImageReplace | InstallAction::LinuxPackageCommand => {
                self.install_linux(bytes)
            }
        }
    }

    /// Downloads, verifies, and installs the selected update in one step.
    pub async fn download_and_install<C>(&self, on_chunk: C) -> Result<()>
    where
        C: FnMut(usize),
    {
        let bytes = self.download(on_chunk).await?;
        self.install(&bytes)
    }
}

#[cfg(not(target_os = "macos"))]
impl Update {
    pub(crate) fn install_macos(&self, _bytes: &[u8]) -> Result<()> {
        Err(Error::UnsupportedOs)
    }
}

#[cfg(not(target_os = "windows"))]
impl Update {
    pub(crate) fn install_windows(&self, _bytes: &[u8]) -> Result<()> {
        Err(Error::UnsupportedOs)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl Updater {
    pub(crate) fn install_inner(&self, _bytes: &[u8]) -> Result<()> {
        Err(Error::UnsupportedOs)
    }

    pub(crate) fn relaunch_inner(&self) -> Result<()> {
        Err(Error::UnsupportedOs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderMap;
    use std::ffi::OsString;

    fn test_update(installer_kind: InstallerKind) -> Update {
        Update {
            current_version: Version::parse("1.0.0").unwrap(),
            version: Version::parse("1.0.1").unwrap(),
            date: None,
            body: None,
            raw_json: serde_json::json!({}),
            download_url: Url::parse("https://example.com/release-hub.AppImage").unwrap(),
            signature: String::new(),
            pubkey: String::new(),
            target: "linux-x86_64".into(),
            installer_kind,
            headers: HeaderMap::new(),
            timeout: None,
            proxy: None,
            no_proxy: false,
            dangerous_accept_invalid_certs: false,
            dangerous_accept_invalid_hostnames: false,
            extract_path: PathBuf::from("/tmp/release-hub"),
            app_name: "ReleaseHub".into(),
            installer_args: Vec::new(),
        }
    }

    #[test]
    fn windows_installers_use_launch_route() {
        assert_eq!(
            test_update(InstallerKind::Msi).install_action(),
            InstallAction::WindowsExecutableLaunch
        );
        assert_eq!(
            test_update(InstallerKind::Nsis).install_action(),
            InstallAction::WindowsExecutableLaunch
        );
    }

    #[test]
    fn windows_installer_args_build_expected_command_line() {
        let args = vec![
            OsString::from("/quiet"),
            OsString::from("C:\\Program Files\\Release Hub"),
            OsString::from("quote\"here"),
        ];

        assert_eq!(
            windows_installer_args_command_line(&args),
            Some(String::from(
                "/quiet \"C:\\Program Files\\Release Hub\" \"quote\\\"here\""
            ))
        );
    }
}
