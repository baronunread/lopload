//! GitHub Release-backed source adapter.

use crate::{
    Error, InstallerKind, ReleaseManifestPlatform, ReleaseSource, RemoteRelease,
    RemoteReleaseInner, Result, SourceFuture, SourceRequest,
};
use http::header::{ACCEPT, AUTHORIZATION};
use http::{HeaderMap, HeaderValue};
use octocrab::{
    Octocrab,
    models::repos::{Asset, Release},
};
use semver::Version;
use serde_json::json;
use std::{collections::HashMap, path::Path};
use time::OffsetDateTime;

#[derive(Debug, Clone)]
struct FixtureRelease {
    version: String,
    assets: Vec<FixtureAsset>,
}

impl ReleaseSource for GitHubSource {
    fn fetch<'a>(&'a self, request: &'a SourceRequest) -> SourceFuture<'a> {
        Box::pin(async move { self.release_source_impl(request).await })
    }
}

#[derive(Debug, Clone)]
struct FixtureAsset {
    name: String,
    value: String,
}

#[derive(Debug, Clone)]
enum SignatureSource<'a> {
    Download(&'a Asset),
    Fixture(&'a str),
}

/// Release source backed by the latest GitHub Release of a repository.
///
/// Assets are matched by target marker in the filename, and each installer
/// asset must have a sibling `.sig` or `.minisig` asset with the same base
/// name.
#[derive(Debug, Clone)]
pub struct GitHubSource {
    client: octocrab::Octocrab,
    owner: String,
    repo: String,
    fixture_release: Option<FixtureRelease>,
    asset_headers: HeaderMap,
}

impl GitHubSource {
    /// Creates a GitHub-backed release source for production use.
    ///
    /// Anonymous requests are subject to GitHub API rate limits and only work
    /// for public repositories.
    pub fn new(owner: impl Into<String>, repo: impl Into<String>) -> Self {
        Self {
            client: Octocrab::default(),
            owner: owner.into(),
            repo: repo.into(),
            fixture_release: None,
            asset_headers: HeaderMap::new(),
        }
    }

    /// Creates a GitHub-backed source that authenticates requests with a personal access token.
    ///
    /// This enables private-repository releases and higher GitHub API rate limits. The same
    /// token is propagated to release-asset and signature downloads handled by the updater.
    pub fn with_auth_token(
        owner: impl Into<String>,
        repo: impl Into<String>,
        token: impl AsRef<str>,
    ) -> Result<Self> {
        let token = token.as_ref();
        let client = Octocrab::builder().personal_token(token).build().unwrap();
        let mut asset_headers = HeaderMap::new();
        asset_headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))?,
        );

        Ok(Self {
            client,
            owner: owner.into(),
            repo: repo.into(),
            fixture_release: None,
            asset_headers,
        })
    }

    /// Creates a GitHub-backed source from a custom Octocrab client.
    ///
    /// Use this when you need a preconfigured GitHub client with custom
    /// middleware, base URLs, or authentication strategy.
    pub fn with_client(
        owner: impl Into<String>,
        repo: impl Into<String>,
        client: Octocrab,
    ) -> Self {
        Self {
            client,
            owner: owner.into(),
            repo: repo.into(),
            fixture_release: None,
            asset_headers: HeaderMap::new(),
        }
    }

    /// Builds a fixture-backed source for tests that need deterministic assets
    /// without hitting the GitHub API.
    ///
    /// This helper is intentionally test-oriented. Production code should use
    /// [`GitHubSource::new`] so signatures are fetched from the real paired
    /// release asset.
    #[doc(hidden)]
    pub fn from_assets(
        owner: impl Into<String>,
        repo: impl Into<String>,
        version: &str,
        assets: Vec<(&str, &str)>,
    ) -> Self {
        Self {
            client: Octocrab::default(),
            owner: owner.into(),
            repo: repo.into(),
            fixture_release: Some(FixtureRelease {
                version: version.into(),
                assets: assets
                    .into_iter()
                    .map(|(name, value)| FixtureAsset {
                        name: name.into(),
                        value: value.into(),
                    })
                    .collect(),
            }),
            asset_headers: HeaderMap::new(),
        }
    }

    /// Fetches and adapts the latest GitHub release into the crate's neutral release model.
    pub(crate) async fn release_source_impl(
        &self,
        request: &SourceRequest,
    ) -> Result<RemoteRelease> {
        if let Some(fixture_release) = &self.fixture_release {
            let asset = select_fixture_target_asset(&fixture_release.assets, &request.target)?;
            let signature_asset =
                find_fixture_signature_asset(&fixture_release.assets, &asset.name)
                    .ok_or_else(|| Error::MissingSignatureAsset(asset.name.clone()))?;
            let download_asset = fixture_download_asset(asset, 1);

            return build_remote_release_from_assets(
                &request.target,
                &fixture_release.version,
                None,
                None,
                &download_asset,
                SignatureSource::Fixture(&signature_asset.value),
                &HeaderMap::new(),
            )
            .await;
        }

        let release = self
            .client
            .repos(&self.owner, &self.repo)
            .releases()
            .get_latest()
            .await?;
        let pub_date = parse_pub_date(&release)?;
        let asset = select_target_asset(&release.assets, &request.target)?;
        let signature_asset = find_signature_asset(&release.assets, &asset.name)
            .ok_or_else(|| Error::MissingSignatureAsset(asset.name.clone()))?;

        build_remote_release_from_assets(
            &request.target,
            &release.tag_name,
            release.body.clone(),
            pub_date,
            asset,
            SignatureSource::Download(signature_asset),
            &self.asset_headers,
        )
        .await
    }
}

fn fixture_asset(id: u64, name: &str, url: &str) -> Asset {
    serde_json::from_value(json!({
        "url": format!("https://api.github.com/assets/{id}"),
        "browser_download_url": url,
        "id": id,
        "node_id": format!("asset-{id}"),
        "name": name,
        "label": null,
        "state": "uploaded",
        "content_type": "application/octet-stream",
        "size": 1,
        "digest": null,
        "download_count": 0,
        "created_at": "2026-04-21T00:00:00Z",
        "updated_at": "2026-04-21T00:00:00Z",
        "uploader": null
    }))
    .expect("fixture asset should deserialize")
}

fn fixture_download_asset(asset: &FixtureAsset, id: u64) -> Asset {
    fixture_asset(id, &asset.name, &asset.value)
}

fn is_signature_asset(name: &str) -> bool {
    name.ends_with(".sig") || name.ends_with(".minisig")
}

fn target_variants(target: &str) -> [String; 3] {
    [
        target.to_ascii_lowercase(),
        target.replace('-', "_").to_ascii_lowercase(),
        target.replace('_', "-").to_ascii_lowercase(),
    ]
}

fn select_target_asset<'a>(assets: &'a [Asset], target: &str) -> Result<&'a Asset> {
    let variants = target_variants(target);
    assets
        .iter()
        .filter(|asset| !is_signature_asset(&asset.name))
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            variants.iter().any(|variant| name.contains(variant))
                && InstallerKind::from_path(Path::new(&asset.name)).is_ok()
        })
        .ok_or_else(|| Error::TargetNotFound(target.into()))
}

fn select_fixture_target_asset<'a>(
    assets: &'a [FixtureAsset],
    target: &str,
) -> Result<&'a FixtureAsset> {
    let variants = target_variants(target);
    assets
        .iter()
        .filter(|asset| !is_signature_asset(&asset.name))
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            variants.iter().any(|variant| name.contains(variant))
                && InstallerKind::from_path(Path::new(&asset.name)).is_ok()
        })
        .ok_or_else(|| Error::TargetNotFound(target.into()))
}

fn find_signature_asset<'a>(assets: &'a [Asset], name: &str) -> Option<&'a Asset> {
    let sig_name = format!("{name}.sig");
    let minisig_name = format!("{name}.minisig");
    assets
        .iter()
        .find(|asset| asset.name == sig_name || asset.name == minisig_name)
}

fn find_fixture_signature_asset<'a>(
    assets: &'a [FixtureAsset],
    name: &str,
) -> Option<&'a FixtureAsset> {
    let sig_name = format!("{name}.sig");
    let minisig_name = format!("{name}.minisig");
    assets
        .iter()
        .find(|asset| asset.name == sig_name || asset.name == minisig_name)
}

fn parse_release_version(version: &str) -> Result<Version> {
    Version::parse(version.trim_start_matches('v')).map_err(Error::Semver)
}

fn parse_pub_date(release: &Release) -> Result<Option<OffsetDateTime>> {
    release
        .published_at
        .as_ref()
        .map(|published_at| {
            OffsetDateTime::parse(
                &published_at.to_rfc3339(),
                &time::format_description::well_known::Rfc3339,
            )
            .map_err(Error::Time)
        })
        .transpose()
}

async fn load_signature(source: SignatureSource<'_>, asset_headers: &HeaderMap) -> Result<String> {
    match source {
        SignatureSource::Download(signature_asset) => {
            let download_url = if asset_headers.is_empty() {
                signature_asset.browser_download_url.clone()
            } else {
                signature_asset.url.clone()
            };

            let mut headers = asset_headers.clone();
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));

            Ok(reqwest::Client::new()
                .get(download_url)
                .headers(headers)
                .send()
                .await?
                .error_for_status()?
                .text()
                .await?)
        }
        SignatureSource::Fixture(signature) => Ok(signature.to_string()),
    }
}

async fn build_remote_release_from_assets(
    target: &str,
    version: &str,
    notes: Option<String>,
    pub_date: Option<OffsetDateTime>,
    asset: &Asset,
    signature_source: SignatureSource<'_>,
    asset_headers: &HeaderMap,
) -> Result<RemoteRelease> {
    let signature = load_signature(signature_source, asset_headers).await?;
    let download_url = if asset_headers.is_empty() {
        asset.browser_download_url.clone()
    } else {
        asset.url.clone()
    };
    let platforms = HashMap::from([(
        target.to_string(),
        ReleaseManifestPlatform {
            url: download_url,
            signature,
        },
    )]);

    Ok(RemoteRelease {
        version: parse_release_version(version)?,
        notes,
        pub_date,
        data: RemoteReleaseInner::Static { platforms },
        download_headers: asset_headers.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn with_auth_token_preserves_repository_identity() {
        let source = GitHubSource::with_auth_token("owner-name", "repo-name", "test-token")
            .expect("token-backed source should build");

        assert_eq!(source.owner, "owner-name");
        assert_eq!(source.repo, "repo-name");
        assert!(source.fixture_release.is_none());
        assert!(source.asset_headers.contains_key(AUTHORIZATION));
    }
}
