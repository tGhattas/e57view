## What this changes

<!-- One paragraph. What behaviour is different, and for whom. -->

## How it was checked

<!-- This project measures things rather than asserting that they ran. If you changed
     geometry, analysis, I/O or the agent surface, say which driver covers it and what
     numbers it produced, like "drive-fit.mjs 22/22, plane normal 0.008°". If you added a
     capability, say which driver you added. -->

- [ ] `npx tsc --noEmit -p tsconfig.json`
- [ ] `npm run build`
- [ ] relevant `drive-*.mjs` drivers pass (say which, with numbers)
- [ ] `cargo run --release --bin anatest --manifest-path crates/e57-wasm/Cargo.toml` if Rust changed
- [ ] `npm run test:mcp` if the agent surface changed
- [ ] README / FINDINGS / `public/llms.txt` / `mcp/tools.json` updated if this is user- or agent-facing

## Anything left undone

<!-- Known gaps are fine. Silent ones are not. -->
