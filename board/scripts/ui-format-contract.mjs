import assert from 'node:assert/strict';

import { formatCount, formatMonthYear, money } from '../static/format-core.js';

assert.equal(formatCount(0, 'order'), '0 orders');
assert.equal(formatCount(1, 'order'), '1 order');
assert.equal(formatCount(2, 'order'), '2 orders');
assert.equal(formatCount(1, 'unit'), '1 unit');
assert.equal(formatCount(2, 'unit'), '2 units');

assert.equal(money(0), '$0');
assert.equal(money(884), '$884');
assert.equal(money(-884), '−$884');
assert.equal(money(-1250, { compact: true }), '−$1.3k');
assert.equal(money(-884.39, { digits: 2 }), '−$884.39');

assert.equal(formatMonthYear('2026-08-01'), 'Aug 2026');
assert.equal(formatMonthYear('2026-08-01', { long: true }), 'August 2026');
assert.equal(formatMonthYear(null), '—');

console.log('UI format contract: pluralization, currency, and month-year cases pass.');
