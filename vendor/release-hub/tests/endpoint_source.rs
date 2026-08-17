use httpmock::Method::GET;
use httpmock::MockServer;
use release_hub::{EndpointSource, ReleaseSource, SourceRequest, verify_minisign};
use url::Url;

#[tokio::test]
async fn endpoint_source_fetches_static_manifest() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/latest.json");
        then.status(200).body(
            r#"{
                "version": "1.2.3",
                "notes": "Stable",
                "pub_date": "2026-04-21T08:00:00Z",
                "platforms": {
                    "linux-x86_64": {
                        "url": "https://downloads.example/app.AppImage",
                        "signature": "sig-linux"
                    }
                }
            }"#,
        );
    });

    let source = EndpointSource::new(vec![Url::parse(&server.url("/latest.json")).unwrap()]);
    let release = source
        .fetch(&SourceRequest::new("linux-x86_64"))
        .await
        .unwrap();

    assert_eq!(release.signature("linux-x86_64").unwrap(), "sig-linux");
}

#[tokio::test]
async fn endpoint_source_surfaces_http_status_failures() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/latest.json");
        then.status(500).body("internal error");
    });

    let source = EndpointSource::new(vec![Url::parse(&server.url("/latest.json")).unwrap()]);
    let err = source
        .fetch(&SourceRequest::new("linux-x86_64"))
        .await
        .unwrap_err();

    assert!(
        matches!(err, release_hub::Error::Reqwest(http_err) if http_err.is_status() && http_err.status() == Some(reqwest::StatusCode::INTERNAL_SERVER_ERROR))
    );
}

#[test]
fn verifier_accepts_known_good_minisign_fixture() {
    verify_minisign(
        b"test",
        include_str!("fixtures/minisign/test.pub"),
        include_str!("fixtures/minisign/test.sig"),
    )
    .unwrap();
}
