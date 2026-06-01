import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commissionSchedule, round2 } from '../lib/calcs.js';

test('commissionSchedule matches the tender guide (aggressive)', () => {
  // installments 10k / 40k / 50k, total commission 5,000, cap 25%
  const f = commissionSchedule([10000, 40000, 50000], { total: 5000, capRate: 0.25 });
  assert.deepEqual(f, [2500, 2500, 0]);
  assert.equal(f.reduce((a, b) => a + b, 0), 5000);
});

test('commissionSchedule never over-collects past the entitlement', () => {
  const f = commissionSchedule([100000, 100000], { total: 5000, capRate: 0.25 });
  assert.deepEqual(f, [5000, 0]);
});

test('commissionSchedule throws on non-numeric input', () => {
  assert.throws(() => commissionSchedule([NaN], { total: 100, capRate: 0.25 }));
  assert.throws(() => commissionSchedule([100], { total: 'x', capRate: 0.25 }));
});

test('round2', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(2500.005), 2500.01);
});
