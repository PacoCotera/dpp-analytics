import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'static', 'chart-system.js'), 'utf8');
const context = { window: { d3: {} }, console };
runInNewContext(source, context);

const { trajectoryTickValues } = context.window.DPPCharts;
const indexes = Array.from({ length: 26 }, (_, index) => index);
const positions = (width) => indexes.map((index) => ((index + 0.5) * width) / indexes.length);
const assertSpacing = (values, width, minimumSpacing) => {
  const centers = values.map((value) => positions(width)[value]);
  centers.slice(1).forEach((center, index) => {
    assert.ok(
      center - centers[index] >= minimumSpacing,
      `${width}px tick centers must remain at least ${minimumSpacing}px apart`,
    );
  });
};

const desktop = trajectoryTickValues(indexes, positions(1100), 1100, false);
assert.deepEqual(Array.from(desktop), [0, 4, 7, 11, 14, 18, 21, 25]);
assertSpacing(desktop, 1100, 76);

const desktopNarrow = trajectoryTickValues(indexes, positions(560), 560, false);
assert.deepEqual(Array.from(desktopNarrow), [0, 4, 8, 13, 17, 21, 25]);
assertSpacing(desktopNarrow, 560, 76);

const compact = trajectoryTickValues(indexes, positions(260), 260, true);
assert.deepEqual(Array.from(compact), [0, 8, 17, 25]);
assertSpacing(compact, 260, 64);

const compactWide = trajectoryTickValues(indexes, positions(620), 620, true);
assert.deepEqual(Array.from(compactWide), [0, 4, 7, 11, 14, 18, 21, 25]);
assertSpacing(compactWide, 620, 64);

const constrained = trajectoryTickValues(indexes, positions(120), 120, true);
assert.deepEqual(Array.from(constrained), [0, 25]);

assert.deepEqual(Array.from(trajectoryTickValues([4], [50], 100, true)), [4]);
assert.deepEqual(Array.from(trajectoryTickValues([4, 9], [20, 80], 100, true)), [4, 9]);

for (const values of [desktop, desktopNarrow, compact, compactWide, constrained]) {
  assert.equal(values[0], 0, 'the first weekly endpoint must remain labeled');
  assert.equal(values.at(-1), 25, 'the final weekly endpoint must remain labeled');
}

console.log('Trajectory tick contract: endpoint labels and width-aware spacing pass.');
