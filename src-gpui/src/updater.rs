use release_hub::{Config, Updater, UpdaterBuilder};
#[cfg(target_os = "linux")]
use std::process::Command;
use std::time::Duration;
use url::Url;

const UPDATE_ENDPOINT: &str =
    "https://github.com/baronunread/lopload/releases/latest/download/latest.json";
const UPDATE_PUBLIC_KEY: &str = "untrusted comment: minisign public key: 73B849F1E65C64C2\nRWTCZFzm8Um4cwvQKFkTIETfuncBuyzFvt1u8VHT+hxBWKrd5qDw/HJb";

#[derive(Clone)]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: Option<String>,
}

fn updater() -> Result<Updater, String> {
    let endpoint = Url::parse(UPDATE_ENDPOINT).map_err(|_| "The update URL is invalid")?;
    let config = Config {
        endpoints: vec![endpoint],
        pubkey: UPDATE_PUBLIC_KEY.into(),
        ..Default::default()
    };
    let builder = UpdaterBuilder::new("Lopload", env!("CARGO_PKG_VERSION"), config)
        .timeout(Duration::from_secs(60));
    #[cfg(target_os = "linux")]
    let builder = builder.executable_path(std::env::var_os("APPIMAGE").ok_or_else(|| {
        "Updates for this Linux package are handled by its package manager".to_string()
    })?);
    builder
        .build()
        .map_err(|_| "The updater could not be started".into())
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "The updater could not be started".into())
}

pub fn check() -> Result<Option<AvailableUpdate>, String> {
    let updater = updater()?;
    let update = runtime()?
        .block_on(updater.check())
        .map_err(|_| "Lopload could not check for updates".to_string())?;
    Ok(update.map(|update| AvailableUpdate {
        version: update.version.to_string(),
        notes: update.body,
    }))
}

pub fn install_and_relaunch() -> Result<(), String> {
    let updater = updater()?;
    let runtime = runtime()?;
    let update = runtime
        .block_on(updater.check())
        .map_err(|_| "Lopload could not check for updates".to_string())?
        .ok_or_else(|| "Lopload is already up to date".to_string())?;
    runtime
        .block_on(update.download_and_install(|_| {}))
        .map_err(|_| "The signed update could not be installed".to_string())?;

    #[cfg(target_os = "macos")]
    updater
        .relaunch()
        .map_err(|_| "Lopload was updated but could not restart".to_string())?;

    #[cfg(target_os = "linux")]
    {
        let executable = std::env::current_exe()
            .map_err(|_| "Lopload was updated but could not restart".to_string())?;
        Command::new(executable)
            .spawn()
            .map_err(|_| "Lopload was updated but could not restart".to_string())?;
        std::process::exit(0);
    }

    #[cfg(target_os = "windows")]
    unreachable!("the Windows installer exits the running application");

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_is_pinned_to_https_and_the_embedded_key() {
        assert!(UPDATE_ENDPOINT.starts_with("https://"));
        assert!(UPDATE_PUBLIC_KEY.contains("73B849F1E65C64C2"));
        assert!(minisign_verify::PublicKey::decode(UPDATE_PUBLIC_KEY).is_ok());
        let config = Config {
            endpoints: vec![Url::parse(UPDATE_ENDPOINT).expect("valid update URL")],
            pubkey: UPDATE_PUBLIC_KEY.into(),
            ..Default::default()
        };
        assert!(config.validate().is_ok());
    }
}
