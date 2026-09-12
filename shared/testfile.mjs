// SPDX-License-Identifier: GPL-3.0-only
// Where the big test scan lives, for the drivers that need a real one.
//
// A handful of drivers exercise things that only show up at scale — a 3 GB decode, a cache
// write, a panorama, the level-of-detail budget — and no such file can live in this
// repository. They read `E57VIEW_TEST_FILE`, and say plainly what to set when it is missing
// rather than failing with ENOENT on a path from somebody else's machine.

import { existsSync } from 'node:fs';

export const TEST_FILE = process.env.E57VIEW_TEST_FILE || '';

/** The path, or null after printing how to provide one. Callers exit 0: a skipped driver is
 *  not a failing one, and CI has no scan to give it. */
export function requireTestFile(what = 'a large scan') {
  if (TEST_FILE && existsSync(TEST_FILE)) return TEST_FILE;
  console.log(`SKIPPED — this driver needs ${what} and E57VIEW_TEST_FILE is not set to one.`);
  console.log('  export E57VIEW_TEST_FILE=/path/to/your/scan.e57');
  console.log('  Any E57 will do; the numbers in the README came from a 3.23 GB, 73.8M-point one.');
  return null;
}
