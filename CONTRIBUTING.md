<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Contributing

Thanks for looking. This is a short guide with one unusual rule in it, so the rule comes first.

## Measure it

Every feature here ships with a driver that measures something against a known answer. Not a
test that checks the code ran. A test that computes a number and compares it to a number you
can work out independently.

That is why the README can say a unit cube reads 6.000 m² and 1.000 m³, that a shell of points
250 mm outside a sphere mesh reads 249.96 to 250.64 mm, that a volume lands 0.11% from
arithmetic, and that a cylinder fit is 0.0000° off the axis. Each of those is a driver
asserting it on every run. Each of them caught a real bug the day it was written.

If you can't think of a number your change should produce, that's worth a few minutes before
you write the code. There usually is one:

- Geometry: build a fixture whose answer is arithmetic. A cube, a sphere, a pyramid, a plane
  at a known height. Look at `room-fixture.mjs` and the fixtures at the top of `drive-fit.mjs`
  and `drive-raster.mjs`.
- File formats: round-trip it. Write the file, read it back, compare the geometry.
- A transform: apply it and its inverse, or apply a known one and check the box.
- Something ported from another tool: transcribe that tool's algorithm into the test as an
  oracle and assert your version produces the same output. `crates/e57-wasm/src/bin/anatest.rs`
  does this for CloudCompare's SOR and noise filters.
- The agent surface: drive it the way an agent does, over the real transport.
- Genuinely qualitative: say so in the driver's own words, and assert the strongest thing that
  can be checked. A count, a bounding box, that a row appeared.

A driver's output is prose. `PASS  the pipe fits a cylinder along Y · 0.0000° off the Y axis`.
Write the checks so somebody who has never seen the code can tell what was proved.

## Reporting a bug

Open an issue. There's a template, and the fields on it are the ones we always end up asking
for:

- What you did, what you expected, what happened.
- Which build: the web version, or the desktop app and which version and OS.
- The file, described rather than attached: format, size, roughly how many points, and the
  scanner if you know it. "E57, 3.2 GB, 73.8M points, NavVis VLX" tells us a lot.
- Anything in the console. In a browser that's the developer console; in the desktop app it's
  the terminal, if you started it from one.

Please don't attach scan data to a public issue. Most problems reproduce on a small synthetic
file, and building one is usually faster than sanitising a real scan. If you're sure the bug
needs your specific file, say so in the issue and we'll find a private way to get it.

## Proposing a feature

Open an issue before writing code, if the change would add or alter a panel control or an MCP
tool. Those two surfaces are the ones other people build habits on, and it is easier to agree
on the shape of a thing before it exists.

Describe the task, not the button. "Measure clearance under a beam" tells us more than "add a
measure tool", and often the answer turns out to be a different feature from the one you
asked for.

Good first issues are labelled. If none are open, the roadmap at the bottom of the README lists
what's missing, and `docs/cloudcompare-gap-analysis.md` has 190 rows of it with a note on each
saying exactly what differs.

## Setting up

macOS, Linux and Windows all work. You need Node 20 and, only if you're changing Rust, a Rust
toolchain.

```sh
npm ci
npm ci --prefix mcp                # only for the Node MCP server
npm run dev                        # http://127.0.0.1:5180
```

For the Rust side:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128
npm run wasm
```

The wasm-bindgen CLI version has to equal the `wasm-bindgen` version in
`crates/e57-wasm/Cargo.toml` exactly. They generate and consume a private ABI that changes
between releases, so a mismatch produces bindings that load and then fail in ways that look
like your code is wrong. If `npm run wasm` complains about a version, that is why. The pin is
0.2.128 today; if you bump the crate, bump the CLI in the same commit.

On Linux the desktop build also needs the webview:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf
```

On Windows, install the Rust MSVC toolchain and Visual Studio Build Tools. WebView2 ships with
Windows 11 and recent Windows 10.

## Running the tests

There are four kinds, and they run separately.

```sh
npx tsc --noEmit -p tsconfig.json                     # types
npm run build                                         # the web bundle
npm run test:mcp                                      # both MCP servers against mcp/tools.json
cargo run --release --bin anatest \
  --manifest-path crates/e57-wasm/Cargo.toml          # geometry, against known answers
```

The browser drivers need a built app being served. Start it once and leave it running:

```sh
npm run build && npx vite preview --port 5180 &
node drive-fit.mjs
```

Run one driver at a time while you work. `drive-fit.mjs` is a good one to read first: it builds
a room with a ball and a pipe in it, fits primitives, and checks each against the shape that was
planted.

A few drivers need a real multi-gigabyte scan, which can't live in this repository. They read
`E57VIEW_TEST_FILE` and skip with an explanation when it isn't set:

```sh
export E57VIEW_TEST_FILE=/path/to/your/scan.e57
node drive-cache.mjs
```

The desktop app is driven through its own MCP server rather than Playwright. A WKWebView isn't
a browser you can attach to, and the MCP interface is the one an agent will really use:

```sh
npm run desktop:build
E57VIEW_TEST_FILE=... node drive-desktop.mjs
```

## What a pull request needs

- A driver check for anything that changes behaviour. Say which driver and what numbers it
  produced.
- A `FINDINGS.md` entry if you measured something, or if something surprised you. That file is
  the engineering log and it is the most useful thing in the repository.
- `mcp/tools.json` updated if you changed the agent surface, plus `public/llms.txt` and the
  `/agent` help in `functions/index.js`.
- An SPDX header on new files. `node tools/spdx.mjs` adds them.
- `node tools/third-party.mjs` rerun if you added a dependency. It regenerates
  `THIRD_PARTY.md` and fails if the licence can't be combined with GPL-3.0.
- `README.md` updated if the change is visible to a user.

The PR template lists these with checkboxes. CI runs all of it.

## How review works

We read for correctness first and shape second. The questions that come up most:

- What number says this works, and where is it asserted?
- What happens on a 70-million-point cloud? Anything that reads every point back from the GPU
  needs to say why.
- Does this add a second place where the same fact lives? Tool definitions, defaults and
  version numbers each have one home, and a change that adds another will get a comment.
- Is the comment explaining why, or restating the line below it?

Expect questions rather than rewrites. If a change is right but the test is missing, we'll ask
for the test rather than merging and hoping.

## Style

The code has a voice. Please match it rather than fighting it.

Comments say why, not what. A comment that restates the line below it is noise. A comment that
says "re-boxing a rotated box inflates it, so measure again from a sample" is the reason the
next person doesn't undo the fix. Most of the long comments here exist because something was
wrong once, and the comment is what stops it coming back.

British spelling in prose and in identifiers we own: `centre`, `colour`. Web APIs keep their
own spelling, so `color` where the platform says `color`.

Two-space indentation in TypeScript, rustfmt defaults in Rust. No new runtime dependencies
without a reason in the pull request. The viewer's only production dependencies are three.js
and, in the web build, Firebase.

## Commit messages

One logical step per commit. The first line is a sentence, not a category prefix. The body
explains the change to somebody who wasn't here, and if the change has numbers, so does the
message. Look at `git log` for the shape of it.

## Cutting a release

Versions live in five files. `npm run release` sets all of them:

```sh
npm run release -- 0.1.0        # add --dry-run to see what it would touch
```

It sets the version in `package.json`, `mcp/package.json`, `desktop/tauri.conf.json`,
`desktop/Cargo.toml` and `crates/e57-wasm/Cargo.toml`, plus the lock files, checks they agree,
moves the `## Unreleased` section of `CHANGELOG.md` under a dated heading, commits, and creates
the annotated tag. Then it stops. Pushing a tag publishes binaries, so you type that part
yourself:

```sh
git push origin main v0.1.0
```

That starts `.github/workflows/release.yml`: the same checks any commit gets, then the same
desktop matrix `build.yml` uses, then a GitHub Release with the `.dmg`, the Windows installer,
the `.deb`, the `.AppImage` and a `SHA256SUMS.txt`. The release notes are the CHANGELOG section
the tag names.

To undo before pushing: `git tag -d v0.1.0 && git reset --hard HEAD~1`.

Two things to know. Actions has to be able to run at all: on a private repository GitHub bills
Actions minutes and refuses the run until billing is set up, with the message "recent account
payments have failed or your spending limit needs to be increased". On a public repository it
is free. And the first release is unsigned, so macOS refuses the first open and Windows
SmartScreen warns once. The release notes say so, and `.github/workflows/build.yml` lists the
secrets to add when there are certificates.

## Licence and conduct

Contributions are accepted under **GPL-3.0-only**, the same licence as the rest of the project.
There is no CLA to sign and no copyright assignment.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through
[SECURITY.md](SECURITY.md) rather than a public issue.

[ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) names the projects this one is built on top of. If
you have used something we forgot to credit, a pull request against that file is welcome.
