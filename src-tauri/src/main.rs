// The desktop app: a native window around the same single-file page the web build ships (dist/index.html,
// built with `--mode desktop`), plus what only an app can do for it — files by path, the Open dialogs, Show
// in Finder (files.rs) — and the notes and folders Finder opens with it (docs/architecture.md, "The DESKTOP
// app is a Tauri window round the same page").

// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;

use std::sync::Mutex;

// Paths Finder asked the app to open (a double-click, Open With, a drop on the Dock icon), kept until the
// page takes them: one may arrive before the page has loaded, so a bare event could go unheard.
#[derive(Default)]
struct Opened(Mutex<Vec<String>>);

#[tauri::command]
fn take_opened_paths(opened: tauri::State<'_, Opened>) -> Vec<String> {
    std::mem::take(&mut *opened.0.lock().unwrap())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Opened::default())
        // Paths given on the command line open too: how Windows and Linux hand a file to an app.
        .setup(|app| {
            use tauri::Manager;
            let paths = std::env::args().skip(1).filter(|arg| !arg.starts_with('-'));
            app.state::<Opened>().0.lock().unwrap().extend(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::list_files,
            files::read_texts,
            files::read_bytes,
            files::write_text,
            files::write_bytes,
            files::remove_file,
            files::remove_empty_dir,
            files::kind_of,
            files::stat,
            files::read_text_at,
            files::write_text_at,
            files::pick_folder,
            files::pick_note,
            files::reveal,
            take_opened_paths,
        ])
        .build(tauri::generate_context!())
        .expect("Corkboard could not start");
    app.run(on_event);
}

// macOS hands opened files to the running app as an event; the page is told to come and take them.
#[cfg(target_os = "macos")]
fn on_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    use tauri::{Emitter, Manager};
    if let tauri::RunEvent::Opened { urls } = event {
        let paths = urls
            .into_iter()
            .filter_map(|url| url.to_file_path().ok())
            .map(|path| path.to_string_lossy().into_owned());
        app.state::<Opened>().0.lock().unwrap().extend(paths);
        let _ = app.emit("opened", ());
    }
}

#[cfg(not(target_os = "macos"))]
fn on_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {}
