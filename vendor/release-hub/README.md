<div align=center>
<h1 align="center">
ReleaseHub
</h1>
<p align="center">
A source-agnostic auto-updater for Rust desktop applications.
</p>
<p align="center">
<a href="https://crates.io/crates/release-hub"> <img alt="Crates.io Version" src="https://img.shields.io/crates/v/release-hub?style=for-the-badge"> </a>
<a href="https://docs.rs/release-hub"> <img alt="docs.rs" src="https://img.shields.io/docsrs/release-hub?style=for-the-badge"> </a>
<img alt="License: MIT OR Apache-2.0" src="https://img.shields.io/crates/l/release-hub?style=for-the-badge">
</p>
</div>

`release-hub` checks for signed updates, downloads the artifact for the current target,
and hands installation off to the platform-specific path for that package type.
The primary workflow is manifest-first: your app points at an HTTPS endpoint that serves
release metadata plus a minisign signature for each artifact. GitHub Releases support is
still available, but now as an optional source adapter instead of the crate's core model.

## Features

- Manifest-first update checks from HTTPS endpoints
- Minisign verification before install
- Pluggable release sources through `ReleaseSource`
- Target-aware artifact resolution from a single release manifest
- Download progress callbacks during install
- Configurable headers, proxy, timeout, and executable path overrides

## Supported platforms

- macOS: installs `.app.tar.gz` and `.app.zip` bundles by replacing the app bundle
- Windows: launches `.exe` and `.msi` installers, including configured installer arguments
- Linux: replaces `.AppImage` files in place and launches `.deb` / `.rpm` installs through `pkexec`

`Updater::relaunch()` is currently implemented only on macOS and Windows.

## Quick start

Add to your `Cargo.toml`:

```toml
[dependencies]
release-hub = "*"
```

```rust,no_run
use release_hub::{Config, UpdaterBuilder};
use url::Url;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config {
        endpoints: vec![Url::parse("https://updates.example.com/latest.json")?],
        pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".into(),
        ..Default::default()
    };

    let updater = UpdaterBuilder::new("MyApp", "1.0.0", config).build()?;
    if let Some(update) = updater.check().await? {
        update
            .download_and_install(|chunk| eprintln!("downloaded {chunk} bytes"))
            .await?;
    }

    Ok(())
}
```

## Endpoint manifests and minisign verification

`Config::endpoints` is the default source. Each endpoint should return release metadata
for the latest version and provide a minisign signature for every platform artifact.

```json
{
  "version": "1.0.1",
  "notes": "Bug fixes and stability improvements.",
  "pub_date": "2026-04-21T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://updates.example.com/MyApp-aarch64.app.tar.gz",
      "signature": "untrusted comment: signature from minisign secret key\nRW..."
    },
    "linux-x86_64": {
      "url": "https://updates.example.com/MyApp-x86_64.AppImage",
      "signature": "untrusted comment: signature from minisign secret key\nRW..."
    },
    "windows-x86_64": {
      "url": "https://updates.example.com/MyApp-x86_64.msi",
      "signature": "untrusted comment: signature from minisign secret key\nRW..."
    }
  }
}
```

The updater selects the entry matching the current target, downloads the artifact,
verifies it with the configured public key, and then runs the install path for that
artifact type.

## Installer naming requirements

Downloaded installer artifacts must follow these naming rules so `release-hub` can
recognize the package type and, when using GitHub Releases, match the asset to the
current target.

### Supported file extensions

Installer filenames must end with one of the supported package extensions:

- macOS: `.app.tar.gz`, `.app.zip`
- Linux: `.AppImage`, `.deb`, `.rpm`
- Windows: `.msi`, `.exe`

If the filename does not end with one of these extensions, the installer format
cannot be resolved.

### Target marker for GitHub release assets

When using `GitHubSource`, the release asset name must contain the target marker for
the platform it serves. Canonical target markers are:

- `darwin-aarch64`
- `linux-x86_64`
- `windows-x86_64`

GitHub asset matching also accepts the same marker with `-` and `_` swapped, such as
`linux_x86_64` or `windows_x86_64`.

The rest of the filename is flexible, but the asset name must include a recognizable
target marker and end with a supported installer extension.

### Signature file requirement

Each installer asset must have a paired detached minisign signature asset using one
of these filenames:

- `<installer-name>.sig`
- `<installer-name>.minisig`

Examples:

- `MyApp-darwin-aarch64.app.tar.gz`
- `MyApp-darwin-aarch64.app.tar.gz.sig`
- `MyApp-linux-x86_64.AppImage`
- `MyApp-linux-x86_64.AppImage.minisig`
- `MyApp-windows-x86_64.msi`
- `MyApp-windows-x86_64.msi.sig`

### Manifest note

When using manifest endpoints directly, the filename itself does not need to include
the target marker because target selection happens through the `platforms` map. The
artifact URL must still point to a file with a supported installer extension.

## GitHub releases as a source adapter

Use `GitHubSource` when your release metadata lives in GitHub Releases but you still
want the same updater flow. The GitHub adapter expects the target asset plus a paired
`.sig` or `.minisig` asset on the release.

```rust,no_run
use release_hub::{Config, GitHubSource, UpdaterBuilder};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config {
        pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".into(),
        ..Default::default()
    };

    let updater = UpdaterBuilder::new("MyApp", "1.0.0", config)
        .source(Box::new(GitHubSource::new("owner", "repo")))
        .build()?;

    let _ = updater;
    Ok(())
}
```

For private repositories or to avoid anonymous rate limits, build the source with a
personal access token:

```rust,no_run
use release_hub::{Config, GitHubSource, UpdaterBuilder};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("GITHUB_TOKEN")?;
    let config = Config {
        pubkey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3".into(),
        ..Default::default()
    };

    let source = GitHubSource::with_auth_token("owner", "repo", token)?;
    let updater = UpdaterBuilder::new("MyApp", "1.0.0", config)
        .source(Box::new(source))
        .build()?;

    let _ = updater;
    Ok(())
}
```

## Configuration notes

- `header(...)` and `headers(...)` let you attach authentication or cache-control headers
- `proxy(...)` and `no_proxy()` control HTTP routing
- `timeout(...)` sets a request timeout for manifest fetches and downloads
- `executable_path(...)` overrides the detected install target when your app needs it
- `installer_arg(...)` and `installer_args(...)` append extra Windows installer arguments

## Install behavior by package type

- `.app.tar.gz` / `.app.zip`: extracted and swapped into place on macOS
- `.exe` / `.msi`: written to a temporary path and launched on Windows
- `.AppImage`: written to `current_executable.new` and atomically renamed on Linux
- `.deb`: installed with `pkexec dpkg -i`
- `.rpm`: installed with `pkexec rpm -U`

## Projects using this crate

- [bibcitex](https://github.com/tangxiangong/bibcitex)
- [fenban](https://github.com/tangxiangong/fenban)

---

## Third-Party Code Attribution

- **Source**: [tauri-apps/tauri-plugin-updater](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/updater)
- **Author**: The Tauri Programme
- **License**: [MIT](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/LICENSE_MIT) OR [MIT](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/LICENSE_MIT)/[Apache 2.0](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/LICENSE_APACHE-2.0)
- **Usage**: Implement updater for Dioxus apps or any other Rust GUI applications
- **Copyright**: Copyright (c) 2015 - Present - The Tauri Programme within The Commons Conservancy.
- **Key Modifications**:
  - Adapt for universal Rust crate
  - Remove Tauri-specific runtime integration
  - Add manifest-based endpoint sources and pluggable release-source adapters

> **Detailed Info**: For complete attribution information, please refer to the [**NOTICE**](./NOTICE) file

## License

Licensed under either of:

 * Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or <https://www.apache.org/licenses/LICENSE-2.0>)
 * MIT license ([LICENSE-MIT](LICENSE-MIT) or <https://opensource.org/licenses/MIT>)

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any
additional terms or conditions.
