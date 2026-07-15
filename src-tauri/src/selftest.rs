// Support for the in-app self-test runner (src/selftest/mount.tsx) — Runner B,
// which runs the same tests/scenarios/* list as `bun test` but inside the real
// Tauri binary, against the real Rust IPC path.
//
// Both commands are compiled only into debug builds: `cfg(debug_assertions)`
// on the module, and again on each `generate_handler!` entry in lib.rs, so
// neither can ship in a release binary no matter how main.tsx is wired.

/// Prints a line to the *process's* stdout. The webview's `console.log`
/// doesn't reach the terminal `bunx tauri dev` runs in, so the self-test
/// runner reports its results through this command instead — that's what lets
/// `scripts/selftest.ts` read the machine-readable sentinel lines back out.
#[tauri::command]
pub fn selftest_log(line: String) {
    println!("{line}");
}

/// Exits the whole app with `code`, once the self-test runner has finished and
/// printed its result. Only ever invoked behind `VITE_LOPLOAD_SELFTEST` (see
/// src/main.tsx) — nothing in a normal build calls it.
#[tauri::command]
pub fn selftest_exit(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}
