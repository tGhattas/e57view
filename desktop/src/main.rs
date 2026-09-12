// e57view, as a desktop application.
//
// The whole viewer is the same code the web build runs — the same Rust decoder compiled to
// WebAssembly, the same WebGL2 renderer, the same workers, the same OPFS cache. What the
// shell adds is the three things a web page cannot have: files by path, real Save dialogs,
// and an MCP server that needs no Node and no network.
//
// Nothing here talks to the internet. The desktop build of the page carries no analytics tag,
// no web fonts and no Firebase, and the only socket this process opens is a listener on
// 127.0.0.1 for the agent bridge.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod files;
mod mcp;
mod menu;

use std::borrow::Cow;
use std::sync::Arc;

use tauri::{Emitter, Listener, Manager};

fn port() -> u16 {
    std::env::var("E57VIEW_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(bridge::DEFAULT_PORT)
}

fn main() {
    // `e57view --mcp` is not a window. It is an MCP server on this process's stdin and
    // stdout that relays tool calls to whichever copy of the app is already running, so an
    // agent registers the app itself rather than a script beside it.
    if std::env::args().any(|a| a == "--mcp") {
        mcp::run_stdio(port());
        return;
    }
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("e57view {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let bridge = bridge::Bridge::new();
    let b = bridge.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(files::Files::default())
        .manage(bridge.clone())
        .invoke_handler(tauri::generate_handler![
            files::native_open,
            files::native_close,
            files::write_open,
            files::write_chunk,
            files::write_close,
            files::read_all,
            files::recents,
            files::clear_recents,
            bridge_status,
            open_paths,
        ])
        // Byte ranges out of an open file, for the workers' synchronous reader. The page asks
        // for e57vfile://localhost/<id>?off=N&len=M and gets exactly those bytes.
        .register_uri_scheme_protocol("e57vfile", move |ctx, request| {
            let app = ctx.app_handle();
            let uri = request.uri();
            let id = uri.path().trim_start_matches('/').parse::<u64>().unwrap_or(0);
            let mut off = 0u64;
            let mut len = 0usize;
            for pair in uri.query().unwrap_or("").split('&') {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                match k {
                    "off" => off = v.parse().unwrap_or(0),
                    "len" => len = v.parse().unwrap_or(0),
                    _ => {}
                }
            }
            if std::env::var("E57VIEW_TRACE").is_ok() {
                eprintln!("[e57vfile] id={id} off={off} len={len}");
            }
            let state = app.state::<files::Files>();
            let body = if len == 0 || len > 512 * 1024 * 1024 {
                Vec::new()
            } else {
                files::read_range(&state, id, off, len).unwrap_or_default()
            };
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "application/octet-stream")
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-store")
                .body(Cow::Owned(body))
                .unwrap()
        })
        .setup(move |app| {
            let handle = app.handle().clone();

            // the agent bridge, on localhost only
            let bport = port();
            let b2 = b.clone();
            tauri::async_runtime::spawn(async move {
                let got = bridge::serve(b2, bport).await;
                let _ = handle.emit(
                    "e57view://bridge",
                    serde_json::json!({ "port": got, "ok": got.is_some() }),
                );
            });

            // the menu bar, rebuilt when the recents list changes
            let h = app.handle().clone();
            let recent = files::recents(h.clone(), h.state::<files::Files>());
            let m = menu::build(&h, &recent)?;
            app.set_menu(m)?;
            let h2 = app.handle().clone();
            app.on_menu_event(move |app, ev| {
                let r = files::recents(app.clone(), app.state::<files::Files>());
                menu::handle(app, ev.id().0.as_str(), &r);
                let _ = &h2;
            });

            // rebuild the menu when the page says the recents list moved
            let h3 = app.handle().clone();
            app.listen_any("e57view://recents-changed", move |_| {
                let r = files::recents(h3.clone(), h3.state::<files::Files>());
                if let Ok(m) = menu::build(&h3, &r) {
                    let _ = h3.set_menu(m);
                }
            });

            // files opened from the command line, so `e57view scan.e57` works
            let args: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).collect();
            if !args.is_empty() {
                let h4 = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // give the page a moment to register its listener
                    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                    let _ = h4.emit("e57view://menu", serde_json::json!({ "id": "open-path", "path": args[0] }));
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("e57view failed to start");
}

/// What the Agent panel shows: whether the bridge is up and whether a viewer is on it.
#[tauri::command]
fn bridge_status(bridge: tauri::State<Arc<bridge::Bridge>>) -> serde_json::Value {
    let (viewer, agents, hello) = bridge.status();
    serde_json::json!({
        "port": port(),
        "viewer": viewer,
        "agents": agents,
        "hello": hello,
        "exe": std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string()),
    })
}

/// Register several paths at once, for a multi-file drop.
#[tauri::command]
fn open_paths(
    app: tauri::AppHandle,
    state: tauri::State<files::Files>,
    paths: Vec<String>,
) -> Result<Vec<files::NativeFile>, String> {
    paths
        .into_iter()
        .map(|p| files::native_open(app.clone(), state.clone(), p))
        .collect()
}
