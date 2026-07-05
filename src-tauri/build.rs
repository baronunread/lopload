fn main() {
    // Declare the custom cfg so `#[cfg(native_keychain)]` doesn't emit
    // unexpected_cfgs warnings. Must come before tauri_build::build().
    println!("cargo::rustc-check-cfg=cfg(native_keychain)");

    tauri_build::build();

    // ── Credential backend selection ─────────────────────────────────
    //
    // `LOPLOAD_NATIVE_KEYCHAIN=1` forces the native OS keychain backend.
    // `LOPLOAD_NATIVE_KEYCHAIN=0` forces the file-based dev store.
    // When unset, defaults to dev store regardless of profile.
    //
    // This is consumed as #[cfg(native_keychain)] in keychain.rs.
    //
    // Usage:
    //   LOPLOAD_NATIVE_KEYCHAIN=1 tauri build   # production build
    //   LOPLOAD_NATIVE_KEYCHAIN=0 tauri build   # explicit dev-store build
    //   bun run tauri dev                        # dev-store (default)
    //   bun run tauri build                      # dev-store (default)

    println!("cargo:rerun-if-env-changed=LOPLOAD_NATIVE_KEYCHAIN");

    let use_native = std::env::var("LOPLOAD_NATIVE_KEYCHAIN")
        .ok()
        .and_then(|v| {
            let v = v.trim().to_lowercase();
            if v == "1" || v == "true" {
                Some(true)
            } else if v == "0" || v == "false" {
                Some(false)
            } else {
                None
            }
        })
        .unwrap_or(false);

    if use_native {
        println!("cargo:rustc-cfg=native_keychain");
    }
}
