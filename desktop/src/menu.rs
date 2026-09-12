// SPDX-License-Identifier: GPL-3.0-only
// The native menu bar. Every item is a message to the page — the viewer already knows how to
// open a file, undo an edit and frame the cloud, and duplicating any of that in Rust would be
// two implementations of one behaviour. The menu's whole job is to say which one happened.

use tauri::menu::{AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Build the menu bar. `recent` is the list of paths to show under File -> Open Recent.
pub fn build<R: Runtime>(app: &AppHandle<R>, recent: &[String]) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);

    let open = MenuItemBuilder::with_id("open", "Open…").accelerator("CmdOrCtrl+O").build(app)?;
    let add = MenuItemBuilder::with_id("add", "Add Layer…").accelerator("CmdOrCtrl+Shift+O").build(app)?;
    let mesh = MenuItemBuilder::with_id("mesh", "Import Mesh…").build(app)?;
    let save = MenuItemBuilder::with_id("save", "Save As…").accelerator("CmdOrCtrl+S").build(app)?;
    let export = MenuItemBuilder::with_id("export", "Export Points…").accelerator("CmdOrCtrl+E").build(app)?;

    let mut recents = SubmenuBuilder::new(app, "Open Recent");
    if recent.is_empty() {
        recents = recents.item(&MenuItemBuilder::with_id("recent-none", "Nothing yet").enabled(false).build(app)?);
    } else {
        for (i, p) in recent.iter().enumerate() {
            let label = std::path::Path::new(p)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            recents = recents.item(&MenuItemBuilder::with_id(format!("recent:{i}"), label).build(app)?);
        }
        recents = recents
            .item(&sep()?)
            .item(&MenuItemBuilder::with_id("recent-clear", "Clear Menu").build(app)?);
    }
    let recents = recents.build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&open)
        .item(&add)
        .item(&mesh)
        .item(&recents)
        .item(&sep()?)
        .item(&save)
        .item(&export)
        .item(&sep()?)
        .item(&PredefinedMenuItem::close_window(app, Some("Close Window"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&MenuItemBuilder::with_id("undo", "Undo").accelerator("CmdOrCtrl+Z").build(app)?)
        .item(&MenuItemBuilder::with_id("redo", "Redo").accelerator("CmdOrCtrl+Shift+Z").build(app)?)
        .item(&sep()?)
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("fit", "Fit to Cloud").accelerator("Home").build(app)?)
        .item(&MenuItemBuilder::with_id("top", "Top View").build(app)?)
        .item(&MenuItemBuilder::with_id("panel", "Toggle Panel").accelerator("Tab").build(app)?)
        .item(&sep()?)
        .item(&MenuItemBuilder::with_id("fullscreen", "Full Screen").accelerator("CmdOrCtrl+Ctrl+F").build(app)?)
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("agentpanel", "Agent and MCP Setup").build(app)?)
        .item(&MenuItemBuilder::with_id("about-e57view", "About e57view").build(app)?)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        let appmenu = SubmenuBuilder::new(app, "e57view")
            .item(&PredefinedMenuItem::about(app, Some("About e57view"), Some(AboutMetadata {
                name: Some("e57view".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                comments: Some("Offline point-cloud viewer. Nothing leaves this machine.".into()),
                license: Some("GPL-3.0-only".into()),
                ..Default::default()
            }))?)
            .item(&sep()?)
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&sep()?)
            .item(&PredefinedMenuItem::quit(app, Some("Quit e57view"))?)
            .build()?;
        return Menu::with_items(app, &[&appmenu, &file, &edit, &view, &help]);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = AboutMetadata::default();
        let quit = SubmenuBuilder::new(app, "App")
            .item(&PredefinedMenuItem::quit(app, Some("Quit"))?)
            .build()?;
        Menu::with_items(app, &[&file, &edit, &view, &help, &quit])
    }
}

/// Turn a menu click into an event the page listens for.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str, recent: &[String]) {
    if let Some(rest) = id.strip_prefix("recent:") {
        if let Some(p) = rest.parse::<usize>().ok().and_then(|i| recent.get(i)) {
            let _ = app.emit("e57view://menu", serde_json::json!({ "id": "open-path", "path": p }));
        }
        return;
    }
    if id == "fullscreen" {
        if let Some(w) = app.get_webview_window("main") {
            let now = w.is_fullscreen().unwrap_or(false);
            let _ = w.set_fullscreen(!now);
        }
        return;
    }
    let _ = app.emit("e57view://menu", serde_json::json!({ "id": id }));
}
