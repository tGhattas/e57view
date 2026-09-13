<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Contributing

Thank you for looking. This document is short and specific, because one rule here is unusual
enough to be worth stating before anything else.

## The rule that matters: measure it

**Every feature ships with a driver that measures something with a known answer.** Not a test
that asserts the code ran — a test that computes a number and compares it to a number you can
derive independently.

That is why the README can say a unit cube reads 6.000 m² and 1.000 m³, that a shell of points
250 mm outside a sphere mesh reads 249.96 to 250.64 mm, that a volume comes out 0.11% from
arithmetic, and that a cylinder fit lands 0.0000° off the axis. Each of those is a driver
asserting it on every run, and each of them caught a real bug when it was written.

If you cannot think of a number your change should produce, that is worth a moment's thought
before writing the code. There usually is one:

- **Geometry** — build a fixture whose answer is arithmetic. A cube, a sphere, a pyramid,
  a plane at a known height. `room-fixture.mjs` and the fixtures at the top of `drive-fit.mjs`
  and `drive-raster.mjs` are the pattern.
- **I/O** — round-trip it. Write the file, read it back, compare the geometry.
- **A transform** — apply it and its inverse, or apply a known one and check the box.
- **The agent surface** — drive it the way an agent does, over the real transport.
- **Genuinely qualitative** — say so in the driver's own words, and assert the strongest thing
  that *is* checkable (a count, a bounding box, that a row appeared).

A driver's output is prose: `PASS  the pipe fits a cylinder along Y · 0.0000° off the Y axis`.
Write the checks so a reader who has never seen the code can tell what was proved.

## Getting set up

    npm ci
    npm ci --prefix mcp                # only for the Node MCP server
    npm run dev                        # http://127.0.0.1:5180

Rust, only if you change the decoder, the analysis or the desktop shell:

    rustup target add wasm32-unknown-unknown
    cargo install wasm-bindgen-cli --version 0.2.128   # must match the wasm-bindgen crate
    npm run wasm

The wasm-bindgen CLI version has to equal the `wasm-bindgen` version in
`crates/e57-wasm/Cargo.toml` exactly, or the generated bindings will not load. If it complains,
that is why.

## Running the tests

    npx tsc --noEmit -p tsconfig.json                   # types
    npm run build                                       # the web bundle
    npm run test:mcp                                    # both MCP servers against mcp/tools.json
    cargo run --release --bin anatest --manifest-path crates/e57-wasm/Cargo.toml

The browser drivers need a built app being served:

    npm run build && npx vite preview --port 5180 &
    node drive-fit.mjs          # and the other drive-*.mjs

A handful of drivers need a real multi-gigabyte scan, which cannot live in this repository.
They read `E57VIEW_TEST_FILE` and skip with an explanation when it is not set:

    export E57VIEW_TEST_FILE=/path/to/your/scan.e57
    node drive-cache.mjs

The desktop app is driven through its own MCP server, not Playwright — a WKWebView is not a
browser you can attach to, and the MCP interface is the one an agent will really use:

    npm run desktop:build
    E57VIEW_TEST_FILE=... node drive-desktop.mjs

## Project layout

| | |
|---|---|
| `src/` | the viewer: renderer, workers, UI, agent link |
| `shared/` | code both the main thread and the workers use (importers, mesh I/O) |
| `crates/e57-wasm/` | Rust: E57/LAS/LAZ decoding, the octree, analysis, shapes, meshing |
| `desktop/` | the Tauri v2 shell, the agent bridge, the Rust MCP server |
| `mcp/` | `tools.json` (the tool definitions both servers read) and the Node MCP server |
| `functions/` | the Cloud Function behind the hosted agent session, web build only |
| `drive-*.mjs` | the drivers |
| `docs/` | the gap analysis and anything else long-form |
| `FINDINGS.md` | the engineering log: what was hard, what was wrong, and the numbers |

## Style

The code has a voice; please match it rather than fighting it.

- **Comments say why, not what.** A comment that restates the line below it is noise. A
  comment that says "re-boxing a rotated box inflates it, so measure again from a sample" is
  the reason the next person does not undo the fix.
- **Name the failure you prevented.** Most of the long comments in this codebase exist because
  something was wrong once, and the comment is what stops it coming back.
- **British spelling** in prose and identifiers (`centre`, `colour` where it is ours;
  `color` where it is a web API).
- Two-space indentation in TypeScript, rustfmt defaults in Rust.
- No new runtime dependencies without a reason in the pull request. The viewer's only
  production dependencies are three.js and, in the web build, Firebase.

## Commits

One logical step per commit, with a message that explains the change to somebody who was not
here. The first line is a sentence, not a category prefix. If the change has numbers, the
message has numbers.

## What to update alongside code

- **User-facing?** `README.md`.
- **Agent-facing?** `mcp/tools.json`, `public/llms.txt`, `functions/index.js` (the `/agent`
  help), and `/agent`'s edit gate if the command changes anything.
- **Hard-won?** `FINDINGS.md`. It is the most useful file here and it is not a changelog —
  it is what was tried, what broke, and what the numbers were.
- **A new source file?** `node tools/spdx.mjs` adds the licence header.
- **A new dependency?** `node tools/third-party.mjs` regenerates `THIRD_PARTY.md` and fails if
  the licence cannot be combined with GPL-3.0.

## Cutting a release

Versions live in five files. `npm run release` sets all of them, so you never have to remember
which:

```sh
npm run release -- 0.1.0        # add --dry-run to see what it would touch
```

That sets the version in `package.json`, `mcp/package.json`, `desktop/tauri.conf.json`,
`desktop/Cargo.toml` and `crates/e57-wasm/Cargo.toml` (plus the lock files), checks they agree,
moves the `## Unreleased` section of `CHANGELOG.md` under a dated heading for the version,
commits, and creates the annotated tag. It stops there. Pushing a tag publishes binaries, so
you type that yourself:

```sh
git push origin main v0.1.0
```

That starts `.github/workflows/release.yml`: the same checks any commit gets, then the same
desktop matrix `build.yml` uses, then a GitHub Release with the `.dmg`, the Windows installer,
the `.deb`, the `.AppImage` and a `SHA256SUMS.txt`, with the release notes taken from the
CHANGELOG section the tag names.

To undo before pushing: `git tag -d v0.1.0 && git reset --hard HEAD~1`.

Two things to know:

- **Actions has to be able to run.** On a private repository, GitHub bills Actions minutes and
  refuses the run until billing is set up — the message is *"recent account payments have
  failed or your spending limit needs to be increased"*. On a public repository it is free.
- **The first release is unsigned.** macOS refuses the first open of an unsigned app and
  Windows SmartScreen warns once; the release notes say so, and the sums are how somebody
  checks their download. `.github/workflows/build.yml` lists the secrets to add when there are
  certificates.

## Licence

By contributing you agree that your contribution is licensed under **GPL-3.0-only**, the same
as the rest of the project. There is no CLA.
