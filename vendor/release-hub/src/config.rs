//! Static updater configuration shared across all release-source implementations.

use serde::{Deserialize, Deserializer, de::Error as DeError};
use std::ffi::OsString;
use url::Url;

/// Windows-specific installer configuration.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsConfig {
    /// Additional arguments forwarded to the Windows installer launch path.
    #[serde(
        default,
        alias = "installer-args",
        deserialize_with = "deserialize_os_string"
    )]
    pub installer_args: Vec<OsString>,
}

/// Persistent updater configuration shared by all release sources.
///
/// This struct is typically assembled once during application startup and then
/// passed into [`crate::UpdaterBuilder`]. It controls endpoint defaults,
/// Minisign verification, and a few escape hatches for local development or
/// unusual networking environments.
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Allows non-HTTPS update endpoints. Intended for development only.
    pub dangerous_insecure_transport_protocol: bool,
    /// Allows invalid TLS certificates during HTTP requests.
    pub dangerous_accept_invalid_certs: bool,
    /// Allows TLS hostname mismatches during HTTP requests.
    pub dangerous_accept_invalid_hostnames: bool,
    /// Default endpoint list used when no custom release source is provided.
    pub endpoints: Vec<Url>,
    /// Minisign public key used to verify downloaded artifacts.
    pub pubkey: String,
    /// Optional Windows-specific installer configuration.
    pub windows: Option<WindowsConfig>,
}

impl Config {
    /// Validates the configuration invariants enforced by this crate.
    ///
    /// In particular, endpoint URLs must use `https` unless
    /// [`Self::dangerous_insecure_transport_protocol`] is enabled.
    pub fn validate(&self) -> crate::Result<()> {
        validate_endpoints(&self.endpoints, self.dangerous_insecure_transport_protocol)
    }
}

fn deserialize_os_string<'de, D>(deserializer: D) -> Result<Vec<OsString>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Vec::<String>::deserialize(deserializer)?
        .into_iter()
        .map(OsString::from)
        .collect())
}

impl<'de> Deserialize<'de> for Config {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct InnerConfig {
            #[serde(default, alias = "dangerous-insecure-transport-protocol")]
            dangerous_insecure_transport_protocol: bool,
            #[serde(default, alias = "dangerous-accept-invalid-certs")]
            dangerous_accept_invalid_certs: bool,
            #[serde(default, alias = "dangerous-accept-invalid-hostnames")]
            dangerous_accept_invalid_hostnames: bool,
            #[serde(default)]
            endpoints: Vec<Url>,
            pubkey: String,
            windows: Option<WindowsConfig>,
        }

        let config = InnerConfig::deserialize(deserializer)?;
        validate_endpoints(
            &config.endpoints,
            config.dangerous_insecure_transport_protocol,
        )
        .map_err(DeError::custom)?;

        Ok(Self {
            dangerous_insecure_transport_protocol: config.dangerous_insecure_transport_protocol,
            dangerous_accept_invalid_certs: config.dangerous_accept_invalid_certs,
            dangerous_accept_invalid_hostnames: config.dangerous_accept_invalid_hostnames,
            endpoints: config.endpoints,
            pubkey: config.pubkey,
            windows: config.windows,
        })
    }
}

pub(crate) fn validate_endpoints(
    endpoints: &[Url],
    dangerous_insecure_transport_protocol: bool,
) -> crate::Result<()> {
    if !dangerous_insecure_transport_protocol {
        for url in endpoints {
            if url.scheme() != "https" {
                return Err(crate::Error::InsecureTransportProtocol);
            }
        }
    }

    Ok(())
}
