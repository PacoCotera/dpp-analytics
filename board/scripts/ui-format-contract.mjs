import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatCount, formatMonthYear, money, percent } from '../static/format-core.js';

assert.equal(formatCount(0, 'order'), '0 orders');
assert.equal(formatCount(1, 'order'), '1 order');
assert.equal(formatCount(2, 'order'), '2 orders');
assert.equal(formatCount(1, 'unit'), '1 unit');
assert.equal(formatCount(2, 'unit'), '2 units');

assert.equal(percent(null), '—');
assert.equal(percent(undefined), '—');
assert.equal(percent(Number.NaN), '—');
assert.equal(percent(0), '0.0%');
assert.equal(percent(12.44), '+12.4%');
assert.equal(percent(-12.44), '−12.4%');
assert.equal(percent(12.44, { sign: false }), '12.4%');
assert.equal(percent(-12.44, { sign: false }), '−12.4%');
assert.equal(percent(0.125, { scale: 100, sign: false }), '12.5%');
assert.equal(percent(1234.56, { digits: 2 }), '+1,234.56%');
assert.equal(percent(-1234.56, { digits: 0, sign: false }), '−1,235%');

assert.equal(money(0), '$\u00a00');
assert.equal(money(884), '$\u00a0884');
assert.equal(money(-884), '−$\u00a0884');
assert.equal(money(-1250, { compact: true }), '−$\u00a01.3k');
assert.equal(money(-884.39, { digits: 2 }), '−$\u00a0884.39');

assert.equal(formatMonthYear('2026-08-01'), 'Aug 2026');
assert.equal(formatMonthYear('2026-08-01', { long: true }), 'August 2026');
assert.equal(formatMonthYear(null), '—');

const todaySource = await readFile(new URL('../static/today.js', import.meta.url), 'utf8');
assert.match(
  todaySource,
  /<div class="value"><strong>\$\{money\([^)]+\)\}<\/strong><span class="share">/,
  'Today product contribution must preserve separate amount and share elements.',
);

for (const relativePath of [
  '../static/format-core.js',
  '../static/chart-system.js',
  '../static/finance.js',
  '../static/sales-canonical.js',
]) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /\$\$\{/,
    `${relativePath} must not concatenate a dollar sign directly with a formatted amount.`,
  );
}

console.log('UI format contract: pluralization, currency, and month-year cases pass.');
