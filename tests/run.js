/* Runs every tests/*.test.js file in its own Node process and reports a summary.
 * Usage: node tests/run.js [filter]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  const ok = res.status === 0;
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + f + ' (' + (Date.now() - t0) + ' ms)');
  if (!ok) console.log((res.stdout || '') + (res.stderr || ''));
}
console.log(files.length - failed + '/' + files.length + ' test files passed');
process.exit(failed ? 1 : 0);
