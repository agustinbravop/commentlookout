const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(__dirname + '/content.js', 'utf8'), context);

test('sample feed contains nine distinct posts and a move does not mutate the original', () => {
  const ids = vm.runInContext('sample.map(tile => tile.id)', context);
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, 9);
  const moved = vm.runInContext('moveTile(sample.map(tile => tile.id), 0, 8)', context);
  assert.equal(moved[8], ids[0]);
  assert.equal(ids[0], 'morning');
});

test('out-of-range moves leave order unchanged', () => {
  const order = ['a', 'b', 'c'];
  const move = vm.runInContext('moveTile', context);
  assert.equal(move(order, 0, -1), order);
  assert.equal(move(order, -1, 1), order);
  assert.deepEqual(Array.from(move(order, 0, 1)), ['b', 'a', 'c']);
});

test('local image filenames cannot inject markup into the preview', () => {
  const escape = vm.runInContext('escapeHtml', context);
  assert.equal(escape('a"<script>&'), 'a&quot;&lt;script&gt;&amp;');
});
