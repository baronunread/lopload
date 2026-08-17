//! Neutral release and update models shared across release sources.

use http::HeaderMap;
use semver::Version;
use serde::{Deserialize, Deserializer, Serialize, de::Error as DeError};
use std::{collections::HashMap, ffi::OsString, path::PathBuf, time::Duration};
use time::OffsetDateTime;
use url::Url;

use crate::InstallerKind;

/// Target-specific release payload returned by a manifest.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ReleaseManifestPlatform {
    /// Download URL for the artifact.
    pub url: Url,
    /// Detached minisign signature for the artifact.
    pub signature: String,
}

/// Release payload shape supported by the updater manifests.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum RemoteReleaseInner {
    /// Single-target payload where one artifact implicitly applies to the
    /// active target.
    Dynamic(ReleaseManifestPlatform),
    /// Multi-target payload keyed by canonical target string.
    Static {
        /// Mapping from target string to downloadable artifact metadata.
        platforms: HashMap<String, ReleaseManifestPlatform>,
    },
}

/// Neutral release model shared by all configured release sources.
#[derive(Debug, Serialize, Clone)]
pub struct RemoteRelease {
    /// Remote version advertised by the source.
    pub version: Version,
    /// Optional release notes or body text.
    pub notes: Option<String>,
    /// Optional publication timestamp.
    pub pub_date: Option<OffsetDateTime>,
    /// Target-specific artifact metadata.
    #[serde(flatten)]
    pub data: RemoteReleaseInner,
    /// Additional headers required when downloading the selected artifact.
    #[serde(skip)]
    pub download_headers: HeaderMap,
}

impl<'de> Deserialize<'de> for RemoteRelease {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct InnerRemoteRelease {
            #[serde(alias = "name")]
            version: Version,
            notes: Option<String>,
            pub_date: Option<String>,
            platforms: Option<HashMap<String, ReleaseManifestPlatform>>,
            url: Option<Url>,
            signature: Option<String>,
        }

        let release = InnerRemoteRelease::deserialize(deserializer)?;
        let pub_date = match release.pub_date {
            Some(date) => Some(
                OffsetDateTime::parse(&date, &time::format_description::well_known::Rfc3339)
                    .map_err(|error| {
                        DeError::custom(format!("invalid value for `pub_date`: {error}"))
                    })?,
            ),
            None => None,
        };

        let data = match release.platforms {
            Some(platforms) => RemoteReleaseInner::Static { platforms },
            None => RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
                url: release.url.ok_or_else(|| {
                    DeError::custom("the `url` field was not set on the updater response")
                })?,
                signature: release.signature.ok_or_else(|| {
                    DeError::custom("the `signature` field was not set on the updater response")
                })?,
            }),
        };

        Ok(Self {
            version: release.version,
            notes: release.notes,
            pub_date,
            data,
            download_headers: HeaderMap::new(),
        })
    }
}

impl RemoteRelease {
    /// Returns the download URL for the requested target.
    ///
    /// Dynamic releases always return the single embedded artifact URL, while
    /// static releases look up the target in their `platforms` map.
    pub fn download_url(&self, target: &str) -> crate::Result<&Url> {
        match &self.data {
            RemoteReleaseInner::Dynamic(platform) => Ok(&platform.url),
            RemoteReleaseInner::Static { platforms } => platforms
                .get(target)
                .map(|platform| &platform.url)
                .ok_or_else(|| crate::Error::TargetNotFound(target.into())),
        }
    }

    /// Returns the detached signature for the requested target.
    pub fn signature(&self, target: &str) -> crate::Result<&String> {
        match &self.data {
            RemoteReleaseInner::Dynamic(platform) => Ok(&platform.signature),
            RemoteReleaseInner::Static { platforms } => platforms
                .get(target)
                .map(|platform| &platform.signature)
                .ok_or_else(|| crate::Error::TargetNotFound(target.into())),
        }
    }
}

/// Ready-to-download update candidate produced by [`crate::Updater::check`].
///
/// This is the fully resolved, target-specific update payload after source
/// selection, manifest decoding, and installer-kind detection.
#[derive(Debug, Clone)]
pub struct Update {
    /// Current application version.
    pub current_version: Version,
    /// Target release version.
    pub version: Version,
    /// Optional release publication date.
    pub date: Option<OffsetDateTime>,
    /// Optional release body or notes.
    pub body: Option<String>,
    /// Raw serialized release payload for advanced consumers.
    pub raw_json: serde_json::Value,
    /// Concrete artifact download URL.
    pub download_url: Url,
    /// Detached minisign signature for the selected artifact.
    pub signature: String,
    /// Minisign public key used for verification.
    pub pubkey: String,
    /// Selected target string.
    pub target: String,
    /// Installer format chosen for the selected artifact.
    pub installer_kind: InstallerKind,
    /// HTTP headers propagated from the updater builder.
    pub headers: HeaderMap,
    /// Optional download timeout.
    pub timeout: Option<Duration>,
    /// Optional proxy configuration.
    pub proxy: Option<Url>,
    /// Whether proxy configuration should be ignored.
    pub no_proxy: bool,
    /// Whether invalid TLS certificates should be accepted.
    pub dangerous_accept_invalid_certs: bool,
    /// Whether invalid TLS hostnames should be accepted.
    pub dangerous_accept_invalid_hostnames: bool,
    /// Final installation target path.
    pub extract_path: PathBuf,
    /// Application name used by platform backends.
    pub app_name: String,
    /// Windows installer arguments propagated from configuration and builder overrides.
    pub installer_args: Vec<OsString>,
}
