// Agent link: a localhost WebSocket bridge to the e57view MCP server, so an AI
// agent can drive the viewer and see the result. Commands are plain JSON; the
// handler map is supplied by main.ts so this file stays free of app internals.
export type Handler = (args: any) => Promise<any> | any;

export class AgentLink {
  ws: WebSocket | null = null;
  connected = false;
  onStatus: ((s: string) => void) | null = null;
  private timer = 0;
  private wanted = false;
  constructor(private handlers: Record<string, Handler>, private port = 7337) {}

  start() { this.wanted = true; this.onStatus?.('connecting to the MCP server on this machine… (Chrome may ask to allow local network access — click Allow)'); this.connect(); }
  stop() { this.wanted = false; clearTimeout(this.timer); this.ws?.close(); this.ws = null; this.connected = false; this.onStatus?.('off'); }

  private connect() {
    if (!this.wanted) return;
    try { this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`); }
    catch { this.retry(); return; }
    this.ws.onopen = () => { this.connected = true; this.onStatus?.('connected'); this.ws!.send(JSON.stringify({ hello: `e57view ${location.href}` })); };
    this.ws.onclose = () => { this.connected = false; this.onStatus?.(this.wanted ? 'waiting for the MCP server… start it with: node mcp/server.mjs (if Chrome asked about local network access, allow it)' : 'off'); this.retry(); };
    this.ws.onerror = () => {};
    this.ws.onmessage = async (ev) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      const h = this.handlers[m.cmd];
      if (!h) { this.ws?.send(JSON.stringify({ id: m.id, ok: false, error: `unknown command ${m.cmd}` })); return; }
      try { const result = await h(m.args ?? {}); this.ws?.send(JSON.stringify({ id: m.id, ok: true, result })); }
      catch (e: any) { this.ws?.send(JSON.stringify({ id: m.id, ok: false, error: String(e?.message ?? e) })); }
    };
  }
  private retry() { clearTimeout(this.timer); if (this.wanted) this.timer = window.setTimeout(() => this.connect(), 2000); }

  /** Binary transfer to the server: [id u32][seq u32][payload]. */
  sendChunk(id: number, seq: number, payload: Uint8Array) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('agent link not connected');
    const out = new Uint8Array(8 + payload.byteLength);
    new DataView(out.buffer).setUint32(0, id, true); new DataView(out.buffer).setUint32(4, seq, true);
    out.set(payload, 8);
    this.ws.send(out);
  }
}
