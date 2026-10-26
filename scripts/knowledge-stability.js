'use strict';
// Three passes, median and range, in one command.
//
// Today's lesson was that a single evaluation run cannot distinguish a change from noise: the same code scored 80, 65 and 75 percent within an hour. This
// script runs the evaluation N times, stops at the first failure, and prints what should be quoted - the median with its range, never a single figure.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const runs = Number(arg('--runs', '3'));
const limit = arg('--limit', '20');
const passages = arg('--passages', '8');
const evalScript = path.join(__dirname, 'knowledge-eval.js');

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
};

const correctness = [];
const citation = [];
for (let run = 1; run <= runs; run += 1) {
  process.stdout.write('run ' + run + '/' + runs + ' ... ');
  const result = spawnSync(process.execPath, [evalScript, '--limit', String(limit), '--passages', String(passages)], { encoding: 'utf8' });
  const output = String(result.stdout || '') + String(result.stderr || '');
  const correct = output.match(/correctness: (\d+)\/(\d+) \((\d+)%\)/);
  const cited = output.match(/cited the right clause (\d+)\/(\d+) \((\d+)%\)/);
  if (!correct || !cited) {
    console.log('FAILED');
    console.log(output.split('\n').slice(-8).join('\n'));
    process.exit(1);
  }
  correctness.push(Number(correct[3]));
  citation.push(Number(cited[3]));
  console.log(correct[3] + '% correct, ' + cited[3] + '% cited');
}

const summary = (label, values) => {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(label + ': median ' + median(values) + '%, range ' + sorted[0] + '-' + sorted[sorted.length - 1] + '% (runs: ' + values.join(', ') + ')');
};

console.log('');
summary('correctness', correctness);
summary('citation   ', citation);
console.log('');
console.log('Quote the median with the range, or do not quote a number.');
