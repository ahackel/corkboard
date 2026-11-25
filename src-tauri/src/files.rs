// What the page asks of the disk: a map folder's files by path, the Open dialogs, Show in Finder. The page
// (src/store/desktop-*.ts) names a folder by its absolute path and a note in it by a '/'-separated path
// relative to it; nothing here reaches outside that folder.

use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

// A file as a listing reports it: its path inside the folder, and the size and modification time that
// tell the page whether something else changed it.
#[derive(Serialize)]
pub struct Entry {
    path: String,
    size: u64,
    mtime: f64,
}

// The same pair after a write, so the page's picture of the folder follows its own saves.
#[derive(Serialize)]
pub struct Stamp {
    size: u64,
    mtime: f64,
}

// `rel` inside `root`: a relative path of plain names, never `..`, never absolute.
fn inside(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = Path::new(root);
    if !root.is_absolute() {
        return Err(format!("not an absolute folder: {}", root.display()));
    }
    let rel = Path::new(rel.trim_end_matches('/'));
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("not a path inside the folder: {}", rel.display()));
    }
    Ok(root.join(rel))
}

fn mtime_of(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

fn stamp_of(path: &Path) -> Result<Stamp, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(Stamp { size: meta.len(), mtime: mtime_of(&meta) })
}

fn text(e: std::io::Error) -> String {
    e.to_string()
}

// Dot-folders and dot-files (`.obsidian`, `.trash`, a half-written save) are another app's business.
fn walk(dir: &Path, prefix: &str, out: &mut Vec<Entry>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(text)? {
        let entry = entry.map_err(text)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // follows a link, as Finder does
        let Ok(meta) = fs::metadata(entry.path()) else { continue };
        let path = format!("{prefix}{name}");
        if meta.is_dir() {
            walk(&entry.path(), &format!("{path}/"), out)?;
        } else {
            out.push(Entry { path, size: meta.len(), mtime: mtime_of(&meta) });
        }
    }
    Ok(())
}

// Every file under `under` ('' = the whole folder, else 'A/B/'), by path, nothing read yet.
#[tauri::command]
pub async fn list_files(root: String, under: String) -> Result<Vec<Entry>, String> {
    let start = if under.is_empty() { PathBuf::from(&root) } else { inside(&root, &under)? };
    let mut out = Vec::new();
    if start.is_dir() {
        walk(&start, &under, &mut out)?;
    }
    Ok(out)
}

// Many notes in one call: a map is hundreds of small files, and each call is a round trip.
#[tauri::command]
pub async fn read_texts(root: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    paths
        .iter()
        .map(|p| {
            let bytes = fs::read(inside(&root, p)?).map_err(text)?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        })
        .collect()
}

#[tauri::command]
pub async fn read_bytes(root: String, path: String) -> Result<Response, String> {
    Ok(Response::new(fs::read(inside(&root, &path)?).map_err(text)?))
}

// Written beside the file under a dot-name, then renamed over it: a crash mid-save leaves the old note
// whole, never half of the new one.
fn write_whole(target: &Path, data: &[u8]) -> Result<Stamp, String> {
    let dir = target.parent().ok_or("no folder to write into")?;
    fs::create_dir_all(dir).map_err(text)?;
    let name = target.file_name().ok_or("no file name")?.to_string_lossy();
    let temp = dir.join(format!(".{name}.corkboard-saving"));
    fs::write(&temp, data).map_err(text)?;
    fs::rename(&temp, target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })?;
    stamp_of(target)
}

#[tauri::command]
pub async fn write_text(root: String, path: String, text: String) -> Result<Stamp, String> {
    write_whole(&inside(&root, &path)?, text.as_bytes())
}

// A picture: the bytes come as the raw body, the folder and path as (percent-encoded) headers.
#[tauri::command]
pub async fn write_bytes(request: Request<'_>) -> Result<Stamp, String> {
    let header = |name: &str| -> Result<String, String> {
        let raw = request.headers().get(name).ok_or(format!("missing {name}"))?;
        percent_decode(raw.to_str().map_err(|e| e.to_string())?)
    };
    let (root, path) = (header("x-root")?, header("x-path")?);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    write_whole(&inside(&root, &path)?, bytes)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

// A file that is already gone is fine.
#[tauri::command]
pub async fn remove_file(root: String, path: String) -> Result<(), String> {
    match fs::remove_file(inside(&root, &path)?) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

// Only an EMPTY folder: whatever else another app put in it keeps it.
#[tauri::command]
pub async fn remove_empty_dir(root: String, path: String) -> Result<(), String> {
    let _ = fs::remove_dir(inside(&root, &path)?);
    Ok(())
}

// "dir", "file" or nothing: what is at an absolute path now.
#[tauri::command]
pub async fn kind_of(path: String) -> Option<&'static str> {
    let meta = fs::metadata(&path).ok()?;
    Some(if meta.is_dir() { "dir" } else { "file" })
}

// The size and modification time of one file by its absolute path (a single note).
#[tauri::command]
pub async fn stat(path: String) -> Result<Stamp, String> {
    stamp_of(Path::new(&path))
}

#[tauri::command]
pub async fn read_text_at(path: String) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&fs::read(&path).map_err(text)?).into_owned())
}

#[tauri::command]
pub async fn write_text_at(path: String, text: String) -> Result<Stamp, String> {
    write_whole(Path::new(&path), text.as_bytes())
}

// Where a dialog opens to find `near` again: the folder that holds it.
fn start_dir(near: Option<String>) -> Option<PathBuf> {
    PathBuf::from(near?).parent().map(Path::to_path_buf)
}

// The system's Open dialog for a folder, opened beside `near` when given. None: cancelled.
#[tauri::command]
pub async fn pick_folder(app: AppHandle, near: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("Open a folder as a board");
    if let Some(dir) = start_dir(near) {
        dialog = dialog.set_directory(dir);
    }
    dialog.blocking_pick_folder()?.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

// …and for one Markdown note.
#[tauri::command]
pub async fn pick_note(app: AppHandle, near: Option<String>) -> Option<String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Open a note")
        .add_filter("Markdown note", &["md", "markdown"]);
    if let Some(dir) = start_dir(near) {
        dialog = dialog.set_directory(dir);
    }
    dialog.blocking_pick_file()?.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

// Show in Finder: the file or folder, selected in its window.
#[tauri::command]
pub async fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_stays_inside_its_folder() {
        assert_eq!(inside("/notes", "A/b.md").unwrap(), PathBuf::from("/notes/A/b.md"));
        assert_eq!(inside("/notes", "A/").unwrap(), PathBuf::from("/notes/A"));
        assert!(inside("/notes", "../secret.md").is_err());
        assert!(inside("/notes", "A/../../secret.md").is_err());
        assert!(inside("/notes", "/etc/passwd").is_err());
        assert!(inside("/notes", "").is_err());
        assert!(inside("notes", "a.md").is_err());
    }

    #[test]
    fn header_values_decode_as_the_page_encoded_them() {
        assert_eq!(percent_decode("%2FUsers%2Fme%2FDesk%20Notes").unwrap(), "/Users/me/Desk Notes");
        assert_eq!(percent_decode("Caf%C3%A9.png").unwrap(), "Café.png");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
    }

    #[test]
    fn a_write_replaces_the_file_whole_and_leaves_nothing_beside_it() {
        let dir = std::env::temp_dir().join(format!("corkboard-test-{}", std::process::id()));
        let target = dir.join("Sub/note.md");
        write_whole(&target, b"one").unwrap();
        let stamp = write_whole(&target, b"two!").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "two!");
        assert_eq!(stamp.size, 4);
        assert_eq!(fs::read_dir(dir.join("Sub")).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
