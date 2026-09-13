<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Panel reference shots

What the side panel looks like, kept so a change to it can be compared against something
rather than remembered. Regenerate them:

```sh
npm run build && npx vite preview --port 5180 &
node tools/full-panel-shot.mjs docs/ui/panel-after.png 266     # the whole panel
node tools/panel-shot.mjs agent docs/ui/agent.png              # one group
node tools/agent-shots.mjs                                      # the Agent tabs, live session
node tools/agent-shots.mjs --desktop                            # the desktop build's tabs
node tools/mesh-shot.mjs docs/ui/mesh-after.png                 # the Mesh group, with a mesh built
```

| File | What it shows |
|---|---|
| `panel-before.png` | the panel before the consistency pass, at 266 px |
| `panel-after.png` | the same panel after it |
| `agent-web-mcp.png` | the MCP tab in the browser build |
| `agent-web-http-idle.png` | the HTTP tab before a session exists |
| `agent-web-http-readonly.png` | a live read-only session |
| `agent-web-http-edits.png` | the same session with edits allowed |
| `agent-web-scripts.png` | the Scripts tab |
| `agent-desktop-mcp.png` | the MCP tab in the desktop build, with the bridge up |
| `agent-desktop-scripts.png` | the Scripts tab there |
| `mesh-after.png` | the Mesh group with a mesh present, so the controls that only appear then are in it |

`agent-shots.mjs` starts a real session against the deployed site rather than faking one in
the DOM, so the badge, the expiry and the dot in the tab are the ones a user would see.
