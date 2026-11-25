// The desktop app: a native window around the same single-file page the web build ships (dist/index.html,
// built with `--mode desktop`). Step 1 of the desktop app is only this window; reading folders by path, the
// menu bar and Show in Finder come next (docs/architecture.md, "The DESKTOP app is a Tauri window").

// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Corkboard could not start");
}
