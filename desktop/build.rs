fn main() {
    // `tauri::generate_context!()` bakes the built front-end into the binary at macro
    // expansion time, and cargo has no idea that happened — so a rebuilt `dist-desktop` with
    // an unchanged `src/` produces an app containing the *previous* front-end. That is a
    // genuinely nasty failure: everything compiles, the app runs, and it is the wrong app.
    // The same goes for the MCP tool definitions, which are `include_str!`d.
    println!("cargo:rerun-if-changed=../dist-desktop");
    println!("cargo:rerun-if-changed=../mcp/tools.json");
    tauri_build::build()
}
