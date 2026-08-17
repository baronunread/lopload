//! Release-source abstraction and built-in source implementations.
//!
//! Most applications can rely on [`EndpointSource`] or [`GitHubSource`], while
//! advanced integrations can implement [`ReleaseSource`] to fetch release data
//! from any service that can produce a [`crate::RemoteRelease`].

/// Endpoint-backed release source implementation.
pub mod endpoint;
/// GitHub Release-backed source implementation.
pub mod github;

use crate::RemoteRelease;
use std::{future::Future, pin::Pin};

/// Parameters supplied to a release source when resolving update metadata.
#[derive(Debug, Clone)]
pub struct SourceRequest {
    /// Requested platform target such as `linux-x86_64`.
    pub target: String,
}

impl SourceRequest {
    /// Creates a new source request for the given canonical target string.
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
        }
    }
}

/// Boxed future returned by [`ReleaseSource::fetch`].
///
/// The boxed future keeps [`ReleaseSource`] object-safe, so callers can store
/// sources behind trait objects such as `Box<dyn ReleaseSource>`.
pub type SourceFuture<'a> = Pin<Box<dyn Future<Output = crate::Result<RemoteRelease>> + Send + 'a>>;

/// Pluggable source of release metadata for the updater pipeline.
///
/// Implement this trait when update metadata comes from a service other than
/// the built-in manifest endpoint or GitHub Release adapters.
pub trait ReleaseSource: Send + Sync {
    /// Fetches release metadata for the requested target.
    fn fetch<'a>(&'a self, request: &'a SourceRequest) -> SourceFuture<'a>;
}

pub use endpoint::EndpointSource;
pub use github::GitHubSource;
