'use strict';

/**
 * Records what this build actually is, at the moment it is made.
 *
 * "Which version am I running?" has to be answerable from inside the app, not by
 * comparing file dates in a release folder — an app that cannot say what it is
 * makes every bug report a guess about whether the fix is even installed.
 *
 * The build number rises on every package, so two builds of the same version are
 * still tellable apart, which is exactly the case that matters while iterating.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'electron', 'build-info.json');
const { version } = require(path.join(root, 'package.json'));

const previous = (() => {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
})();

const info = {
  version,
  // Restart the count when the version changes; otherwise carry on from the last.
  build: previous?.version === version ? (previous.build ?? 0) + 1 : 1,
  builtAt: new Date().toISOString(),
  /*
   * Which copy this is.
   *
   * A build made to work *on* this app rather than in it: its own name, its own
   * data, its own dock icon, and no updater — it is built from a branch, so an
   * update would quietly replace it with whatever was last released and take
   * the thing being tested with it.
   */
  variant: process.env.SMART_TERMINAL_VARIANT === 'dev' ? 'dev' : 'release',
};

fs.writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`);
console.log(`[build] ${info.version} build ${info.build}${info.variant === 'dev' ? ' (dev copy)' : ''} — ${info.builtAt}`);
