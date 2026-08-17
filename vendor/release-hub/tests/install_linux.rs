use http::HeaderMap;
use release_hub::{InstallerKind, LinuxInstallCommand, Update};
use semver::Version;
use std::path::PathBuf;
use url::Url;

#[test]
fn linux_deb_backend_builds_expected_install_command() {
    let command =
        LinuxInstallCommand::for_kind(InstallerKind::Deb, PathBuf::from("/tmp/release-hub.deb"))
            .unwrap();

    assert_eq!(command.program, "pkexec");
    assert_eq!(command.args, vec!["dpkg", "-i", "/tmp/release-hub.deb"]);
}

#[test]
fn linux_appimage_install_writes_real_target_path() {
    let temp_dir = tempfile::tempdir().unwrap();
    let target_path = temp_dir.path().join("ReleaseHub.AppImage");
    let update = Update {
        current_version: Version::parse("1.0.0").unwrap(),
        version: Version::parse("1.0.1").unwrap(),
        date: None,
        body: None,
        raw_json: serde_json::json!({}),
        download_url: Url::parse("https://example.com/ReleaseHub.AppImage").unwrap(),
        signature: String::new(),
        pubkey: String::new(),
        target: "linux-x86_64".into(),
        installer_kind: InstallerKind::AppImage,
        headers: HeaderMap::new(),
        timeout: None,
        proxy: None,
        no_proxy: false,
        dangerous_accept_invalid_certs: false,
        dangerous_accept_invalid_hostnames: false,
        extract_path: target_path.clone(),
        app_name: "ReleaseHub".into(),
        installer_args: Vec::new(),
    };

    update.install(b"payload").unwrap();

    assert_eq!(std::fs::read(&target_path).unwrap(), b"payload");
    assert!(!PathBuf::from(format!("{}.new", target_path.display())).exists());
}
