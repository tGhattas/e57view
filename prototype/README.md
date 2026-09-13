# prototype: validated, working

This is the code the plan's numbers came from. It runs.

## What's here

- `crates/e57-wasm/`: the Rust `Read + Seek` shim over a synchronous JS ranged-read callback,
  plus a `#[wasm_bindgen]` façade. **This is the piece that makes a 3.23 GB file readable from
  wasm32's 4 GB address space.** Includes the windowed cache (see plan: it is mandatory).
- `bench/main.rs`: native benchmark and probe, used to profile decode and inspect file structure.
- `testshim.mjs` and `clean.mjs`: Node harnesses that drive the wasm module with `readSync`,
  standing in for `FileReaderSync` in a Worker.

## Build

```sh
rustup target add wasm32-unknown-unknown
cd crates/e57-wasm
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target nodejs --out-dir ../../pkg \
  target/wasm32-unknown-unknown/release/e57_wasm.wasm
```

Then `node clean.mjs` against a local E57.

## Porting to the browser (milestone M1)

Swap `--target nodejs` for `--target web`, run it in a Worker, and replace the Node callback

```js
const readRange = (offset, length) => { /* readSync into a Uint8Array */ };
```

with

```js
const fr = new FileReaderSync();
const readRange = (offset, length) =>
  new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, offset + length)));
```

Nothing else changes. `FileReaderSync` is worker-only and synchronous, which is exactly what the
Rust `Read` impl needs, and it requires no SharedArrayBuffer and no COOP/COEP headers.

Re-tune `set_window_size()` once in a browser. `FileReaderSync` has higher per-call overhead than
Node's `readSync`, so the optimum may sit above 16 MB.
