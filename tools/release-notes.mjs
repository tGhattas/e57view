// SPDX-License-Identifier: GPL-3.0-only
// Print the CHANGELOG section for one version, with the download note appended.
//
//   node tools/release-notes.mjs v0.1.0
//
// The release notes and the changelog say the same thing because they are the same text. A
// release whose notes were written separately drifts from the changelog immediately, and then
// nobody trusts either.
import { readFileSync } from 'node:fs';

const version = (process.argv[2] || '').replace(/^v/, '');
if (!version) { console.error('Usage: node tools/release-notes.mjs v1.2.3'); process.exit(1); }

const cl = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
// "## 1.2.3" or "## 1.2.3 (2026-09-13)"
const head = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b.*$`, 'm').exec(cl);
if (!head) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
const start = head.index + head[0].length;
const next = /^## /m.exec(cl.slice(start));
const body = cl.slice(start, next ? start + next.index : cl.length).trim();

console.log(body);
console.log(`
## Downloads

| Platform | File |
|---|---|
| macOS (Apple silicon) | \`.dmg\` |
| Windows | \`.exe\` installer |
| Linux | \`.deb\` and \`.AppImage\` |

Check what you downloaded against \`SHA256SUMS.txt\`:

    sha256sum -c SHA256SUMS.txt --ignore-missing

**These builds are not notarised.** The bundle is signed ad-hoc, which is what makes macOS
treat it as intact, but there is no Apple Developer ID behind it, so the first launch is
refused with "cannot be opened because Apple cannot check it for malicious software".

On macOS 15 and later, right-click and *Open* no longer gets past that. Open **System Settings
-> Privacy & Security** and press **Open Anyway** next to the message about e57view, which
appears after the first refused launch. Or clear the quarantine flag yourself:

    xattr -dr com.apple.quarantine /Applications/e57view.app

Windows SmartScreen warns once. Notarisation is on the roadmap; until then the sums above are
how you check that a download is the file this workflow built.

The browser build is at <https://e57view.web.app> and needs no download at all.
`);
