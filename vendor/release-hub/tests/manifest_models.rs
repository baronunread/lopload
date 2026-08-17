use release_hub::{Config, RemoteRelease, RemoteReleaseInner};
use semver::Version;
use url::Url;

#[test]
fn parses_static_manifest_release() {
    let json = r#"{
        "version": "1.2.3",
        "notes": "Bug fixes",
        "pub_date": "2026-04-21T08:00:00Z",
        "platforms": {
            "darwin-aarch64": {
                "url": "https://example.com/app.tar.gz",
                "signature": "sig-darwin"
            },
            "linux-x86_64": {
                "url": "https://example.com/app.AppImage",
                "signature": "sig-linux"
            }
        }
    }"#;

    let release: RemoteRelease = serde_json::from_str(json).unwrap();
    assert_eq!(release.version, Version::parse("1.2.3").unwrap());
    if let RemoteReleaseInner::Static { platforms } = &release.data {
        assert_eq!(platforms.len(), 2);
    } else {
        panic!("expected static manifest release");
    }
    assert_eq!(
        release.download_url("darwin-aarch64").unwrap(),
        &Url::parse("https://example.com/app.tar.gz").unwrap()
    );
    assert_eq!(release.signature("linux-x86_64").unwrap(), "sig-linux");
}

#[test]
fn parses_dynamic_manifest_release() {
    let json = r#"{
        "version": "2.0.0",
        "notes": "Dynamic release",
        "pub_date": "2026-04-21T09:30:00Z",
        "url": "https://example.com/latest/app.tar.gz",
        "signature": "sig-dynamic"
    }"#;

    let release: RemoteRelease = serde_json::from_str(json).unwrap();
    assert_eq!(release.version, Version::parse("2.0.0").unwrap());
    assert_eq!(
        release.download_url("anything").unwrap(),
        &Url::parse("https://example.com/latest/app.tar.gz").unwrap()
    );
    assert_eq!(release.signature("anything").unwrap(), "sig-dynamic");
}

#[test]
fn rejects_http_endpoints_in_release_config() {
    let json = r#"{
        "endpoints": ["http://localhost:3000/latest.json"],
        "pubkey": "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
    }"#;

    let err = serde_json::from_str::<Config>(json).unwrap_err();
    assert!(err.to_string().contains("https"));
}

#[test]
fn rejects_http_endpoints_via_config_validate() {
    let config = Config {
        endpoints: vec![Url::parse("http://localhost:3000/latest.json").unwrap()],
        pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".into(),
        ..Default::default()
    };

    let err = config.validate().unwrap_err();
    assert!(err.to_string().contains("https"));
}

#[test]
fn missing_static_target_returns_target_not_found() {
    let json = r#"{
        "version": "1.2.3",
        "platforms": {
            "darwin-aarch64": {
                "url": "https://example.com/app.tar.gz",
                "signature": "sig-darwin"
            }
        }
    }"#;

    let release: RemoteRelease = serde_json::from_str(json).unwrap();
    let err = release.download_url("linux-x86_64").unwrap_err();
    assert!(matches!(err, release_hub::Error::TargetNotFound(target) if target == "linux-x86_64"));
    let err = release.signature("linux-x86_64").unwrap_err();
    assert!(matches!(err, release_hub::Error::TargetNotFound(target) if target == "linux-x86_64"));
}
