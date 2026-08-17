//! HTTP endpoint-backed release source.

use crate::{ReleaseSource, RemoteRelease, Result, SourceFuture, SourceRequest};
use url::Url;

/// Release source backed by one or more HTTP(S) manifest endpoints.
#[derive(Debug, Clone)]
pub struct EndpointSource {
    endpoints: Vec<Url>,
}

impl EndpointSource {
    /// Creates an endpoint-backed release source.
    ///
    /// The provided endpoints should return JSON compatible with
    /// [`crate::RemoteRelease`]. The current implementation fetches the first
    /// configured endpoint.
    pub fn new(endpoints: Vec<Url>) -> Self {
        Self { endpoints }
    }

    pub(crate) async fn release_source_impl(
        &self,
        _request: &SourceRequest,
    ) -> Result<RemoteRelease> {
        let endpoint = self
            .endpoints
            .first()
            .cloned()
            .ok_or_else(|| crate::Error::Network("no endpoints configured".into()))?;
        let body = reqwest::get(endpoint)
            .await?
            .error_for_status()?
            .text()
            .await?;
        Ok(serde_json::from_str(&body)?)
    }
}

impl ReleaseSource for EndpointSource {
    fn fetch<'a>(&'a self, request: &'a SourceRequest) -> SourceFuture<'a> {
        Box::pin(async move { self.release_source_impl(request).await })
    }
}
