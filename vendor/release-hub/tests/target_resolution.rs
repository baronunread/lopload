use release_hub::{Arch, InstallerKind, OS, SystemInfo, TargetInfo};
use std::path::Path;

#[test]
fn target_string_covers_linux_aarch64() {
    let info = SystemInfo {
        os: OS::Linux,
        arch: Arch::Arm64,
    };

    assert_eq!(TargetInfo::from_system(info).target, "linux-aarch64");
}

#[test]
fn installer_kind_detects_appimage() {
    let kind = InstallerKind::from_path(Path::new("/tmp/release-hub.AppImage")).unwrap();
    assert_eq!(kind, InstallerKind::AppImage);
}
