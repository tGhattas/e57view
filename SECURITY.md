<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Security

## Reporting

Please report privately rather than in a public issue: open a
[security advisory](../../security/advisories/new) on this repository. If that is not
available to you, open a normal issue saying only that you have found something and asking
for a way to send the details.

There is no bounty. There is a commitment to answer.

## What this program is, as far as security goes

**The viewer never uploads anything.** A scan is read from your disk, decoded in a worker, and
drawn. It does not go to a server, and there is no server that could receive it. The desktop
build opens no network connection at all; the web build fetches its own static assets and
nothing else unless you switch on one of the two agent interfaces below.

That is the whole threat model for the ordinary case. What follows is about the agent
interfaces, which exist so that an AI agent can drive the viewer, and which are the only parts
that accept instructions from outside the page.

## The local MCP bridge, `ws://127.0.0.1:7337`

- **Bound to loopback only.** Nothing off the machine can reach it. There is no
  authentication on it, by design: anything that can open a socket on your loopback interface
  is already running as you, and could read your files directly.
- In the **web build** it is a Node process you start yourself (`mcp/server.mjs`), and it is
  off until you tick *Local MCP*.
- In the **desktop build** the app is the server, and the bridge starts with the app. If that
  is not what you want, run the app with `E57VIEW_PORT` set to a port you control, or do not
  register the MCP server with any agent. An unused bridge accepts connections but has nothing
  to relay.
- A client on the bridge can do anything the panel can do, including deleting points and
  writing files to paths it names. It cannot do anything the viewer itself cannot.

## The hosted agent session, `POST /agent`, web build only

This is the one that crosses a network, so it is the one with a threat model worth stating.

- **Opt-in per tab.** Nothing exists until you press *Copy agent URL*, and the tab revokes its
  own token as it closes.
- **The token is the credential; the session id is only an address.** The id may travel in a
  URL. The token is shown once, kept in memory and `sessionStorage`, and never put in the
  page's URL. The server stores only a SHA-256 of it and compares in constant time.
- **Read-only by default.** A session cannot crop, delete, save, transform, open another file
  or spend provider credit unless the viewer tab has *Allow edits* ticked. The gate is applied
  in the relay *and* again in the tab, and a `script` is exactly as privileged as the steps in
  it, so a read-only session cannot smuggle an editing command through a wrapper.
- **Expires in 8 hours**, or when the tab closes, or when you press *Stop session*.
- **The scan itself never leaves the tab.** The relay carries commands and results: numbers,
  and the JPEG or PNG renders you asked for. Point data goes out only if you explicitly call
  `export`, which streams a file you asked for to the agent that asked for it.
- The relay is a Firebase Cloud Function belonging to whoever deployed that instance. If you
  do not want a third party in the path, use the desktop build, or run your own deployment.
  `src/firebase-config.ts` is the only place that decides which one.

## Dependencies

`THIRD_PARTY.md` is generated from the lock files and lists every dependency and its licence.
Report a vulnerable dependency the same way as anything else.

## What is deliberately not defended against

- **Someone with an account on your machine.** Loopback services, OPFS storage and the
  browser profile are all readable by anything running as you.
- **A hostile scan file.** The decoders are written in safe Rust and refuse malformed input,
  but a file crafted to exhaust memory can still make a tab run out of memory. Report anything
  worse than that, such as a crash outside a panic or a read outside a buffer, as a
  vulnerability.
- **A hostile agent.** If you give an agent an edit-enabled session, it can delete points and
  write files. That is the point of the feature. Give it a read-only session when you are not
  sure.
