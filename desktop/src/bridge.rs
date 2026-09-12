// SPDX-License-Identifier: GPL-3.0-only
// The localhost bridge the viewer and the agents both connect to.
//
// In the web build this socket is the Node MCP server itself: one process that is both the
// WebSocket endpoint and the thing Claude talks to over stdio. The desktop app splits those
// apart, because the app is already running and an MCP client is a separate short-lived
// process. So the app owns a tiny router — one viewer, any number of agents — and
// `e57view --mcp` is an agent that happens to speak MCP on its own stdin and stdout.
//
// The wire protocol is unchanged, deliberately: `{id, cmd, args}` in, `{id, ok, result|error}`
// back, binary frames for export chunks, and a `{hello}` from the viewer as it connects. The
// webview's agent.ts cannot tell which server it is talking to, and neither can an agent.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub const DEFAULT_PORT: u16 = 7337;

type Tx = mpsc::UnboundedSender<Message>;

#[derive(Default)]
struct Inner {
    viewer: Option<(u64, Tx)>,
    agents: HashMap<u64, Tx>,
    /// bridge request id -> (agent connection, the id that agent used)
    routes: HashMap<u64, (u64, serde_json::Value)>,
    hello: Option<String>,
}

#[derive(Default)]
pub struct Bridge {
    inner: Mutex<Inner>,
    next_conn: AtomicU64,
    next_req: AtomicU64,
}

impl Bridge {
    pub fn new() -> Arc<Bridge> {
        Arc::new(Bridge::default())
    }
    /// Whether a viewer window is connected, and what it said about itself.
    pub fn status(&self) -> (bool, usize, Option<String>) {
        let g = self.inner.lock().unwrap();
        (g.viewer.is_some(), g.agents.len(), g.hello.clone())
    }

    fn send_viewer(&self, m: Message) -> bool {
        let g = self.inner.lock().unwrap();
        match &g.viewer {
            Some((_, tx)) => tx.send(m).is_ok(),
            None => false,
        }
    }

    /// One connection's whole life: classify it on its first message, then route.
    async fn connection(self: Arc<Self>, stream: tokio::net::TcpStream) {
        let ws = match tokio_tungstenite::accept_async(stream).await {
            Ok(w) => w,
            Err(_) => return,
        };
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
        });

        let mut role: Option<bool> = None; // Some(true) = viewer, Some(false) = agent
        while let Some(Ok(msg)) = source.next().await {
            match msg {
                Message::Text(t) => {
                    let v: serde_json::Value = match serde_json::from_str(&t) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    // The viewer announces itself; anything else that speaks first is an agent.
                    if role.is_none() {
                        let is_viewer = v.get("hello").is_some();
                        role = Some(is_viewer);
                        let mut g = self.inner.lock().unwrap();
                        if is_viewer {
                            g.hello = v.get("hello").and_then(|h| h.as_str()).map(str::to_owned);
                            g.viewer = Some((id, tx.clone()));
                        } else {
                            g.agents.insert(id, tx.clone());
                        }
                    }
                    if role == Some(true) {
                        if v.get("hello").is_some() {
                            continue;
                        }
                        self.from_viewer(v);
                    } else {
                        self.from_agent(id, v, &tx);
                    }
                }
                Message::Binary(b) => {
                    // export chunks travel viewer -> agents; there is normally one agent, and
                    // fanning out is better than guessing which one asked for a transfer whose
                    // first chunk arrives before the reply that names it
                    if role == Some(true) {
                        let g = self.inner.lock().unwrap();
                        for a in g.agents.values() {
                            let _ = a.send(Message::Binary(b.clone()));
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let mut g = self.inner.lock().unwrap();
        if let Some((vid, _)) = &g.viewer {
            if *vid == id {
                g.viewer = None;
                g.hello = None;
            }
        }
        g.agents.remove(&id);
    }

    /// `{id, cmd, args}` from an agent: renumber so two agents cannot collide, remember who
    /// asked, and hand it to the viewer.
    fn from_agent(&self, conn: u64, v: serde_json::Value, tx: &Tx) {
        let their_id = v.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("").to_string();
        if cmd.is_empty() {
            return;
        }
        let my_id = self.next_req.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut g = self.inner.lock().unwrap();
            if g.viewer.is_none() {
                let err = serde_json::json!({
                    "id": their_id, "ok": false,
                    "error": "No e57view window is connected to the bridge. Open the app (and its Agent panel should read \"MCP: on\")."
                });
                let _ = tx.send(Message::Text(err.to_string()));
                return;
            }
            g.routes.insert(my_id, (conn, their_id));
        }
        let out = serde_json::json!({
            "id": my_id,
            "cmd": cmd,
            "args": v.get("args").cloned().unwrap_or(serde_json::json!({})),
        });
        if !self.send_viewer(Message::Text(out.to_string())) {
            let mut g = self.inner.lock().unwrap();
            g.routes.remove(&my_id);
        }
    }

    /// `{id, ok, result|error}` from the viewer: back to whoever asked, with their own id.
    fn from_viewer(&self, mut v: serde_json::Value) {
        let my_id = match v.get("id").and_then(|i| i.as_u64()) {
            Some(i) => i,
            None => return,
        };
        let (conn, their_id) = {
            let mut g = self.inner.lock().unwrap();
            match g.routes.remove(&my_id) {
                Some(x) => x,
                None => return,
            }
        };
        v["id"] = their_id;
        let g = self.inner.lock().unwrap();
        if let Some(a) = g.agents.get(&conn) {
            let _ = a.send(Message::Text(v.to_string()));
        }
    }
}

/// Start listening. Returns the port, or None when something else already holds it — which is
/// normal if the web build's Node MCP server is running, and is not worth failing the app over.
pub async fn serve(bridge: Arc<Bridge>, port: u16) -> Option<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.ok()?;
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(bridge.clone().connection(stream));
        }
    });
    Some(port)
}
