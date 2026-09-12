// Files by path, which is the thing a native shell can do that a web page cannot.
//
// The decoders were always written against a `readRange(offset, length) -> Uint8Array`
// callback, because the whole point of the E57 reader is that the file never enters memory.
// In a browser that callback is `FileReaderSync` over `File.slice()`. Here it is a range
// request to a custom URL scheme this module serves, which the worker makes with a
// synchronous XHR — workers may do that, and it needs no SharedArrayBuffer, no cross-origin
// isolation and no handshake with the main thread.
//
// Writing is the mirror image: the exporters already produce a file in private storage, and
// the app streams it back out through `write_open` / `write_chunk` / `write_close` to a path
// the user chose in a real Save dialog.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::Manager;

#[derive(Default)]
pub struct Files {
    open: Mutex<HashMap<u64, (String, File)>>,
    writing: Mutex<HashMap<u64, File>>,
    next: Mutex<u64>,
    recent: Mutex<Vec<String>>,
}

impl Files {
    fn id(&self) -> u64 {
        let mut n = self.next.lock().unwrap();
        *n += 1;
        *n
    }
}

/// What the page needs to treat a path like a `File`.
#[derive(Serialize, Clone)]
pub struct NativeFile {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub size: f64,
    #[serde(rename = "lastModified")]
    pub last_modified: f64,
    pub url: String,
}

const MAX_RECENT: usize = 12;

fn recents_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("recent.json"))
}

#[tauri::command]
pub fn native_open(app: tauri::AppHandle, state: tauri::State<Files>, path: String) -> Result<NativeFile, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    let f = File::open(&path).map_err(|e| format!("{path}: {e}"))?;
    let id = state.id();
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let modified = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    state.open.lock().unwrap().insert(id, (path.clone(), f));
    push_recent(&app, &state, &path);
    Ok(NativeFile {
        id,
        name,
        path,
        size: meta.len() as f64,
        last_modified: modified,
        // the worker appends &off=&len= and reads it with a synchronous XHR
        url: format!("e57vfile://localhost/{id}"),
    })
}

#[tauri::command]
pub fn native_close(state: tauri::State<Files>, id: u64) {
    state.open.lock().unwrap().remove(&id);
}

/// Serve one byte range out of an open file. Seeks rather than re-reading: a 3 GB scan is
/// thousands of small ranged reads and every one of them would otherwise pay for an open.
pub fn read_range(state: &Files, id: u64, off: u64, len: usize) -> Option<Vec<u8>> {
    let mut g = state.open.lock().unwrap();
    let (_, f) = g.get_mut(&id)?;
    f.seek(SeekFrom::Start(off)).ok()?;
    let mut buf = vec![0u8; len];
    let mut got = 0;
    while got < len {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(_) => break,
        }
    }
    buf.truncate(got);
    Some(buf)
}

#[tauri::command]
pub fn write_open(state: tauri::State<Files>, path: String) -> Result<u64, String> {
    let f = File::create(&path).map_err(|e| format!("could not write {path}: {e}"))?;
    let id = state.id();
    state.writing.lock().unwrap().insert(id, f);
    Ok(id)
}

/// One chunk, base64 because Tauri's IPC serialises a byte array as JSON numbers otherwise —
/// a third more bytes over a local channel is cheaper than ten times more.
#[tauri::command]
pub fn write_chunk(state: tauri::State<Files>, id: u64, data: String) -> Result<usize, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("bad chunk: {e}"))?;
    let mut g = state.writing.lock().unwrap();
    let f = g.get_mut(&id).ok_or("no such open file")?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(bytes.len())
}

#[tauri::command]
pub fn write_close(state: tauri::State<Files>, id: u64) -> Result<(), String> {
    let mut g = state.writing.lock().unwrap();
    if let Some(mut f) = g.remove(&id) {
        f.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read a whole small file (a mesh, a script) as base64. Guarded by a size cap so this can
/// never be the path a multi-gigabyte scan takes.
#[tauri::command]
pub fn read_all(path: String, max: Option<f64>) -> Result<String, String> {
    let cap = max.unwrap_or(256e6) as u64;
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > cap {
        return Err(format!(
            "{path} is {:.1} MB, over the {:.0} MB this reads whole — open it as a layer instead",
            meta.len() as f64 / 1e6,
            cap as f64 / 1e6
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn recents(app: tauri::AppHandle, state: tauri::State<Files>) -> Vec<String> {
    let mut g = state.recent.lock().unwrap();
    if g.is_empty() {
        if let Some(p) = recents_path(&app) {
            if let Ok(s) = std::fs::read_to_string(p) {
                if let Ok(v) = serde_json::from_str::<Vec<String>>(&s) {
                    *g = v;
                }
            }
        }
    }
    // a file that has been moved or deleted is not a recent file any more
    g.retain(|p| std::path::Path::new(p).exists());
    g.clone()
}

pub fn push_recent(app: &tauri::AppHandle, state: &Files, path: &str) {
    let mut g = state.recent.lock().unwrap();
    g.retain(|p| p != path);
    g.insert(0, path.to_string());
    g.truncate(MAX_RECENT);
    if let Some(p) = recents_path(app) {
        let _ = std::fs::write(p, serde_json::to_string(&*g).unwrap_or_default());
    }
}

#[tauri::command]
pub fn clear_recents(app: tauri::AppHandle, state: tauri::State<Files>) {
    state.recent.lock().unwrap().clear();
    if let Some(p) = recents_path(&app) {
        let _ = std::fs::write(p, "[]");
    }
}
