'use strict';
// The knowledge gate: run the evaluation and fail if quality drops below a floor.
//
// It is deliberately run by a human or a pipeline job, not by `npm test`, because it spends model calls. The floors are
// set below today's measured median so a normal bad run does not fail the build, but a real regression does.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const LIMIT = process.argv.includes('--limit') ? process.argv[process.argv.indexOf('--limit') + 1] : '20';
const FLOORS = {
  correctness: 0.6,        // measured median is ~0.75; below 0.6 is a regression, not noise
  rightClause: 0.25,       // measured ~0.5; below a quarter means retrieval broke
};

let output;
try {
  output = execFileSync(process.execPath, [path.join(__dirname, 'knowledge-eval.js'), '--limit', LIMIT], { encoding: 'utf8' });
} catch (err) {
  console.error('The evaluation did not run:', err.message);
  process.exit(1);
}
process.stdout.write(output);

const correctness = Number((output.match(/correctness: \d+\/\d+ \((\d+)%\)/) || [])[1]) / 100;
const rightClause = Number((output.match(/cited the right clause \d+\/\d+ \((\d+)%\)/) || [])[1]) / 100;

const failures = [];
if (!(correctness >= FLOORS.correctness)) failures.push('correctness ' + correctness + ' < ' + FLOORS.correctness);
if (!(rightClause >= FLOORS.rightClause)) failures.push('right-clause citation ' + rightClause + ' < ' + FLOORS.rightClause);

if (failures.length) {
  console.error('Knowledge gate FAILED:', failures.join('; '));
  process.exit(1);
}
console.log('Knowledge gate passed:', 'correctness', correctness, '>=', FLOORS.correctness,
  '| right clause', rightClause, '>=', FLOORS.rightClause);
