// `e57view --mcp`: an MCP server on stdin and stdout, with no Node anywhere.
//
// It is deliberately not a second implementation of the tools. Every name, description,
// argument schema, timeout and reply shape comes from mcp/tools.json, embedded at build time
// and served verbatim for `tools/list`; a `tools/call` is relayed to the running app over the
// same localhost bridge the Node server uses, and the reply is turned into MCP content by the
// `ui` record in that same file. The Node server does exactly this in JavaScript. Neither can
// drift from the other, because neither is the source.
//
//   claude mcp add e57view -- /Applications/e57view.app/Contents/MacOS/e57view --mcp

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

pub const TOOLS_JSON: &str = include_str!("../../mcp/tools.json");
const PROTOCOL: &str = "2024-11-05";

/// The bridge connection, seen from the MCP process: requests out, replies and export chunks in.
struct Link {
    out: tokio::sync::mpsc::UnboundedSender<Message>,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    chunks: Mutex<HashMap<u32, Vec<Vec<u8>>>>,
    next: AtomicU64,
    connected: Mutex<bool>,
}

impl Link {
    fn call(&self, cmd: &str, args: &Value, timeout_ms: u64) -> Result<Value, String> {
        if !*self.connected.lock().unwrap() {
            return Err("No e57view window is running. Start the app, then try again.".into());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        let msg = json!({ "id": id, "cmd": cmd, "args": args });
        self.out
            .send(Message::Text(msg.to_string()))
            .map_err(|_| "the bridge closed".to_string())?;
        match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms)) {
            Ok(r) => r,
            Err(_) => {
                self.waiting.lock().unwrap().remove(&id);
                Err(format!("the viewer did not answer {cmd} within {}s", timeout_ms / 1000))
            }
        }
    }
    fn take_chunks(&self, transfer: u32) -> Vec<u8> {
        let mut g = self.chunks.lock().unwrap();
        g.remove(&transfer).map(|v| v.concat()).unwrap_or_default()
    }
}

fn tools() -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(TOOLS_JSON).unwrap_or_default()
}
/// What `tools/list` is allowed to show: the MCP fields only, not our own `cmd`/`ui` plumbing.
fn public_tools() -> Vec<Value> {
    tools()
        .into_iter()
        .map(|t| json!({
            "name": t["name"],
            "description": t["description"],
            "inputSchema": t["inputSchema"],
        }))
        .collect()
}

/// Does this call's arguments satisfy a `{"op": ["export"]}`-style condition from tools.json?
fn matches(cond: Option<&Value>, args: &Value) -> bool {
    let Some(c) = cond else { return true };
    let Some(obj) = c.as_object() else { return true };
    obj.iter().all(|(k, vs)| {
        vs.as_array()
            .map(|a| a.iter().any(|v| v == &args[k.as_str()]))
            .unwrap_or(false)
    })
}

fn text_content(v: &Value) -> Value {
    json!({ "type": "text", "text": serde_json::to_string_pretty(v).unwrap_or_default() })
}

/// One tool call, driven entirely by the tool's `ui` record — the same algorithm as the Node
/// server's, reading the same fields.
fn call_tool(link: &Link, def: &Value, args: Value) -> Result<Value, String> {
    let cmd = def["cmd"].as_str().unwrap_or_default();
    let timeout = def["timeoutMs"].as_u64().unwrap_or(60_000);
    let ui = &def["ui"];

    // a tool that writes a file on this machine
    let wf = &ui["writesFile"];
    if wf.is_object() && matches(wf.get("when"), &args) {
        let arg = wf["arg"].as_str().unwrap_or("path");
        if let Some(path) = args.get(arg).and_then(|p| p.as_str()).map(str::to_owned) {
            let mut rest = args.clone();
            rest.as_object_mut().map(|o| o.remove(arg));
            let (buf, meta) = if wf["via"] == "chunks" {
                // the bytes came over the bridge as binary frames while the reply was forming
                let r = link.call(cmd, &rest, timeout)?;
                let transfer = r["transferId"].as_u64().unwrap_or(0) as u32;
                let buf = link.take_chunks(transfer);
                let mut meta = json!({ "saved": path, "bytes": buf.len() });
                if let Some(c) = wf["count"].as_str() {
                    meta[c] = r[c].clone();
                }
                (buf, meta)
            } else {
                // base64 in the reply itself, paged because the HTTP relay caps a reply
                let mut first = rest.clone();
                first["part"] = json!(0);
                let r = link.call(cmd, &first, timeout)?;
                let parts = r["parts"].as_u64().unwrap_or(1);
                let mut b64 = r["data"].as_str().unwrap_or("").to_string();
                for i in 1..parts {
                    let mut a = rest.clone();
                    a["part"] = json!(i);
                    let more = link.call(cmd, &a, timeout)?;
                    b64.push_str(more["data"].as_str().unwrap_or(""));
                }
                let buf = base64::engine::general_purpose::STANDARD
                    .decode(b64.as_bytes())
                    .map_err(|e| format!("the viewer sent something that is not base64: {e}"))?;
                let mut meta = r.clone();
                meta.as_object_mut().map(|o| o.remove("data"));
                meta["saved"] = json!(path);
                meta["bytes"] = json!(buf.len());
                (buf, meta)
            };
            std::fs::write(&path, &buf).map_err(|e| format!("could not write {path}: {e}"))?;
            return Ok(json!({ "content": [text_content(&meta)] }));
        }
    }

    let r = link.call(cmd, &args, timeout)?;

    match ui["shot"].as_str().unwrap_or("never") {
        // a calibrated image the command rendered itself, possibly in parts
        "own-image" => {
            let mut b64 = r["image"]["data"].as_str().unwrap_or("").to_string();
            let parts = r["image"]["parts"].as_u64().unwrap_or(1);
            for i in 1..parts {
                let mut a = args.clone();
                a["part"] = json!(i);
                let more = link.call(cmd, &a, timeout)?;
                b64.push_str(more["image"]["data"].as_str().unwrap_or(""));
            }
            let mime = r["image"]["mime"].as_str().unwrap_or("image/jpeg").to_string();
            let mut rest = r.clone();
            rest.as_object_mut().map(|o| o.remove("image"));
            let mut content = vec![];
            if !b64.is_empty() {
                content.push(json!({ "type": "image", "data": b64, "mimeType": mime }));
            }
            content.push(text_content(&rest));
            Ok(json!({ "content": content }))
        }
        "own-png" => {
            let png = r["png"].as_str().unwrap_or("").to_string();
            let mut rest = r.clone();
            rest.as_object_mut().map(|o| o.remove("png"));
            let mut content = vec![];
            if !png.is_empty() {
                content.push(json!({ "type": "image", "data": png, "mimeType": "image/png" }));
            }
            content.push(text_content(&rest));
            Ok(json!({ "content": content }))
        }
        shot => {
            let mut want = shot == "always";
            if want && ui.get("noShotWhen").is_some() && matches(ui.get("noShotWhen"), &args) {
                want = false;
            }
            if let Some(k) = ui["onlyShotWhenPresent"].as_str() {
                if args.get(k).is_none() {
                    want = false;
                }
            }
            let mut content = vec![text_content(&r)];
            if want {
                // the picture is a courtesy; the answer is the point, so a failure here is not one
                if let Ok(s) = link.call("screenshot", &json!({ "width": 1280 }), 60_000) {
                    if let Some(png) = s["png"].as_str() {
                        content.push(json!({ "type": "image", "data": png, "mimeType": "image/png" }));
                    }
                }
            }
            Ok(json!({ "content": content }))
        }
    }
}

/// Speak MCP on stdin/stdout until stdin closes.
pub fn run_stdio(port: u16) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio");
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let link = Arc::new(Link {
        out: out_tx,
        waiting: Mutex::new(HashMap::new()),
        chunks: Mutex::new(HashMap::new()),
        next: AtomicU64::new(0),
        connected: Mutex::new(false),
    });

    // connect to the running app; keep trying briefly, since the app may be starting
    let l = link.clone();
    rt.spawn(async move {
        let url = format!("ws://127.0.0.1:{port}");
        for attempt in 0..30u32 {
            match tokio_tungstenite::connect_async(&url).await {
                Ok((ws, _)) => {
                    *l.connected.lock().unwrap() = true;
                    let (mut sink, mut source) = ws.split();
                    let l2 = l.clone();
                    tokio::spawn(async move {
                        while let Some(m) = out_rx.recv().await {
                            if sink.send(m).await.is_err() {
                                break;
                            }
                        }
                        let _ = l2;
                    });
                    while let Some(Ok(msg)) = source.next().await {
                        match msg {
                            Message::Text(t) => {
                                let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                                let Some(id) = v["id"].as_u64() else { continue };
                                let w = l.waiting.lock().unwrap().remove(&id);
                                if let Some(w) = w {
                                    let _ = w.send(if v["ok"].as_bool().unwrap_or(false) {
                                        Ok(v["result"].clone())
                                    } else {
                                        Err(v["error"].as_str().unwrap_or("viewer error").to_string())
                                    });
                                }
                            }
                            Message::Binary(b) if b.len() >= 8 => {
                                let id = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                                l.chunks.lock().unwrap().entry(id).or_default().push(b[8..].to_vec());
                            }
                            _ => {}
                        }
                    }
                    *l.connected.lock().unwrap() = false;
                    return;
                }
                Err(_) => {
                    let _ = attempt;
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
            }
        }
    });

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let defs = tools();
    let reply = |v: Value, out: &mut std::io::Stdout| {
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    };
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else { continue };
        let method = msg["method"].as_str().unwrap_or("");
        let id = msg.get("id").cloned();
        // a notification has no id and takes no reply
        if id.is_none() {
            continue;
        }
        let id = id.unwrap();
        let result = match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "e57view", "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": public_tools() })),
            "resources/list" => Ok(json!({ "resources": [] })),
            "prompts/list" => Ok(json!({ "prompts": [] })),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
                let args = msg["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match defs.iter().find(|d| d["name"] == name.as_str()) {
                    None => Err(format!("unknown tool {name}")),
                    Some(def) => call_tool(&link, def, args),
                }
            }
            other => Err(format!("unknown method {other}")),
        };
        match result {
            Ok(r) => reply(json!({ "jsonrpc": "2.0", "id": id, "result": r }), &mut stdout),
            Err(e) => {
                // a failed tool call is a result with isError, not a protocol error: the agent
                // should see the message and decide, not have the call vanish
                if method == "tools/call" {
                    reply(
                        json!({ "jsonrpc": "2.0", "id": id, "result": {
                            "isError": true,
                            "content": [{ "type": "text", "text": e }]
                        }}),
                        &mut stdout,
                    )
                } else {
                    reply(
                        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": e } }),
                        &mut stdout,
                    )
                }
            }
        }
    }
}
