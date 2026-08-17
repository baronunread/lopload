use http::{HeaderMap, HeaderValue, header::AUTHORIZATION};
use httpmock::Method::GET;
use httpmock::MockServer;
use release_hub::{Config, EndpointSource, InstallerKind, Update, UpdaterBuilder};
use semver::Version;
use std::{ffi::OsString, path::PathBuf, time::Duration};
use url::Url;

fn test_config(endpoint: Url) -> Config {
    Config {
        dangerous_insecure_transport_protocol: true,
        endpoints: vec![endpoint],
        pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".into(),
        ..Default::default()
    }
}

fn test_update(download_url: Url, signature: &str) -> Update {
    Update {
        current_version: Version::parse("1.0.0").unwrap(),
        version: Version::parse("1.0.1").unwrap(),
        date: None,
        body: Some("Bug fixes".into()),
        raw_json: serde_json::json!({}),
        download_url,
        signature: signature.into(),
        pubkey: include_str!("fixtures/minisign/test.pub").into(),
        target: "linux-x86_64".into(),
        installer_kind: InstallerKind::AppImage,
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

#[tokio::test]
async fn check_returns_update_when_remote_version_is_newer() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/latest.json");
        then.status(200).body(
            r#"{
                "version": "1.0.1",
                "notes": "Bug fixes",
                "pub_date": "2026-04-21T08:00:00Z",
                "platforms": {
                    "linux-x86_64": {
                        "url": "https://example.com/release-hub.AppImage",
                        "signature": "sig-linux"
                    }
                }
            }"#,
        );
    });

    let endpoint = Url::parse(&server.url("/latest.json")).unwrap();
    let config = test_config(endpoint.clone());

    let updater = UpdaterBuilder::new("ReleaseHub", "1.0.0", config)
        .target("linux-x86_64")
        .source(Box::new(EndpointSource::new(vec![endpoint])))
        .build()
        .unwrap();

    assert_eq!(updater.latest_version(), None);
    let update = updater.check().await.unwrap();
    assert!(update.is_some());
    assert_eq!(
        updater.latest_version(),
        Some(Version::parse("1.0.1").unwrap())
    );
}

#[tokio::test]
async fn check_uses_default_endpoint_source_from_config() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/latest.json");
        then.status(200).body(
            r#"{
                "version": "1.0.1",
                "notes": "Bug fixes",
                "pub_date": "2026-04-21T08:00:00Z",
                "platforms": {
                    "linux-x86_64": {
                        "url": "https://example.com/release-hub.AppImage",
                        "signature": "sig-linux"
                    }
                }
            }"#,
        );
    });

    let endpoint = Url::parse(&server.url("/latest.json")).unwrap();
    let updater = UpdaterBuilder::new("ReleaseHub", "1.0.0", test_config(endpoint))
        .target("linux-x86_64")
        .build()
        .unwrap();

    let update = updater.check().await.unwrap();
    assert!(update.is_some());
}

#[test]
fn build_fails_when_default_config_has_no_endpoints() {
    let config = Config {
        pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".into(),
        ..Default::default()
    };

    match UpdaterBuilder::new("ReleaseHub", "1.0.0", config)
        .target("linux-x86_64")
        .build()
    {
        Ok(_) => panic!("expected build to fail without default endpoints"),
        Err(release_hub::Error::Network(message)) => {
            assert_eq!(message, "no endpoints configured");
        }
        Err(err) => panic!("unexpected error: {err}"),
    }
}

#[tokio::test]
async fn update_download_verifies_minisign_payload() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/release-hub.AppImage");
        then.status(200).body("test");
    });

    let update = test_update(
        Url::parse(&server.url("/release-hub.AppImage")).unwrap(),
        include_str!("fixtures/minisign/test.sig"),
    );

    let mut chunks = Vec::new();
    let bytes = update.download(|chunk| chunks.push(chunk)).await.unwrap();

    assert_eq!(bytes, b"test");
    assert_eq!(chunks, vec![4]);
}

#[tokio::test]
async fn update_download_rejects_invalid_signature() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/release-hub.AppImage");
        then.status(200).body("test");
    });

    let err = test_update(
        Url::parse(&server.url("/release-hub.AppImage")).unwrap(),
        "invalid-signature",
    )
    .download(|_| {})
    .await
    .unwrap_err();

    assert!(matches!(err, release_hub::Error::Minisign(_)));
}

#[tokio::test]
async fn update_download_preserves_configured_headers() {
    let server = MockServer::start();
    let download = server.mock(|when, then| {
        when.method(GET)
            .path("/release-hub.AppImage")
            .header("authorization", "Bearer test-token");
        then.status(200).body("test");
    });

    let endpoint = Url::parse(&server.url("/latest.json")).unwrap();
    let builder = UpdaterBuilder::new("ReleaseHub", "1.0.0", test_config(endpoint))
        .target("linux-x86_64")
        .header(AUTHORIZATION, HeaderValue::from_static("Bearer test-token"))
        .unwrap();

    let mut update = test_update(
        Url::parse(&server.url("/release-hub.AppImage")).unwrap(),
        include_str!("fixtures/minisign/test.sig"),
    );
    update.headers = builder.build().unwrap().headers;

    update.download(|_| {}).await.unwrap();

    download.assert();
}

#[tokio::test]
async fn check_carries_transport_and_install_context_into_update() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(GET).path("/latest.json");
        then.status(200).body(
            r#"{
                "version": "1.0.1",
                "notes": "Bug fixes",
                "pub_date": "2026-04-21T08:00:00Z",
                "platforms": {
                    "linux-x86_64": {
                        "url": "https://example.com/release-hub.AppImage",
                        "signature": "sig-linux"
                    }
                }
            }"#,
        );
    });

    let endpoint = Url::parse(&server.url("/latest.json")).unwrap();
    let proxy = Url::parse("http://127.0.0.1:3128").unwrap();
    let executable_path = PathBuf::from("/tmp/ReleaseHub.app/Contents/MacOS/ReleaseHub");
    let extract_path = PathBuf::from("/tmp/ReleaseHub.app");
    let mut config = test_config(endpoint.clone());
    config.windows = Some(release_hub::WindowsConfig {
        installer_args: vec![OsString::from("/quiet"), OsString::from("/norestart")],
    });
    let updater = UpdaterBuilder::new("ReleaseHub", "1.0.0", config)
        .target("linux-x86_64")
        .source(Box::new(EndpointSource::new(vec![endpoint])))
        .header(AUTHORIZATION, HeaderValue::from_static("Bearer test-token"))
        .unwrap()
        .timeout(Duration::from_secs(9))
        .proxy(proxy.clone())
        .no_proxy()
        .installer_arg("/passive")
        .executable_path(&executable_path)
        .build()
        .unwrap();

    let update = updater.check().await.unwrap().unwrap();

    assert_eq!(
        update.headers.get(AUTHORIZATION),
        Some(&HeaderValue::from_static("Bearer test-token"))
    );
    assert_eq!(update.timeout, Some(Duration::from_secs(9)));
    assert_eq!(update.proxy, Some(proxy));
    assert!(update.no_proxy);
    assert_eq!(update.extract_path, extract_path);
    assert_eq!(update.app_name, "ReleaseHub");
    assert_eq!(
        update.installer_args,
        vec![
            OsString::from("/quiet"),
            OsString::from("/norestart"),
            OsString::from("/passive")
        ]
    );
}
