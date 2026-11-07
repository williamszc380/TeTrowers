/* Loads the DOM-free game modules into Node (for unit tests and tools/sim.js).
 * Usage: const TT = require('./load-core')();  // returns the populated TT namespace
 * Keep CORE_FILES in the same order as the <script> tags in index.html.
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORE_FILES = [
  'js/config.js',
  'js/util.js',
  'js/rng.js',
  'js/shapes.js',
  'js/blocktypes.js',
  'js/generator.js',
  'js/physics.js',
  'js/effects.js',
  'js/placement.js',
  'js/game.js'
];

module.exports = function loadCore(options) {
  const opts = options || {};
  const fs = require('fs');
  if (!global.planck) global.planck = require(path.join(ROOT, 'js/lib/planck.min.js'));
  for (const rel of CORE_FILES) {
    const file = path.join(ROOT, rel);
    if (opts.only && !opts.only.includes(rel)) continue;
    if (!fs.existsSync(file)) {
      if (opts.optional) continue;
      throw new Error('Missing core file: ' + rel);
    }
    delete require.cache[require.resolve(file)];
    require(file);
  }
  return global.TT;
};
module.exports.CORE_FILES = CORE_FILES;
