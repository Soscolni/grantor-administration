import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, extractRefs } from '../lib/calc-expr.js';
import { commissionSchedule, rollup, round2 } from '../lib/calcs.js';

test('expression: arithmetic + precedence', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('(1 + 2) * 3'), 9);
  assert.equal(evaluate('10 / 4'), 2.5);
  assert.equal(evaluate('-5 + 2'), -3);
  assert.equal(evaluate('10 % 3'), 1);
});

test('expression: functions', () => {
  assert.equal(evaluate('min(3, 7, 2)'), 2);
  assert.equal(evaluate('max(3, 7, 2)'), 7);
  assert.equal(evaluate('round(2.345, 2)'), 2.35);
  assert.equal(evaluate('round(2.4)'), 2);
  assert.equal(evaluate('floor(2.9)'), 2);
  assert.equal(evaluate('ceil(2.1)'), 3);
  assert.equal(evaluate('abs(0 - 4)'), 4);
  assert.equal(evaluate('if(1, 10, 20)'), 10);
  assert.equal(evaluate('if(0, 10, 20)'), 20);
  assert.equal(evaluate('if(5 > 3, 1, 2)'), 1);
});

test('expression: variables incl. the commission rule', () => {
  // P = installment amount, R = remaining commission
  assert.equal(evaluate('min({R}, 0.25 * {P})', { R: 5000, P: 10000 }), 2500);
  assert.equal(evaluate('min({R}, 0.25 * {P})', { R: 2500, P: 50000 }), 2500);
  assert.equal(evaluate('{a} + {b}', { a: '1,000', b: 50 }), 1050); // numeric coercion of strings
});

test('expression: errors are explicit, never silent', () => {
  assert.throws(() => evaluate('{missing}', {}), /unknown variable/);
  assert.throws(() => evaluate('{x}', { x: 'abc' }), /not numeric/);
  assert.throws(() => evaluate('bogus(1)'), /unknown function/);
  assert.throws(() => evaluate('1 +'), /unexpected token/);
  assert.throws(() => evaluate('1 ) 2'), /trailing tokens/);
});

test('expression: no arbitrary code execution', () => {
  assert.throws(() => evaluate('process.exit(1)'));
  assert.throws(() => evaluate('constructor'));
});

test('extractRefs lists distinct column refs', () => {
  assert.deepEqual(extractRefs('min({R}, 0.25 * {P}) + {R}'), ['R', 'P']);
  assert.deepEqual(extractRefs('{rel->src} * 2'), ['rel->src']);
});

test('commissionSchedule: aggressive matches the guide example', () => {
  // installments 10k / 40k / 50k, total commission 5,000, cap 25%
  const f = commissionSchedule([10000, 40000, 50000], { total: 5000, capRate: 0.25, strategy: 'aggressive' });
  assert.deepEqual(f, [2500, 2500, 0]);
  assert.equal(f.reduce((a, b) => a + b, 0), 5000);
});

test('commissionSchedule: proportional matches the guide example', () => {
  const f = commissionSchedule([10000, 40000, 50000], { total: 5000, strategy: 'proportional' });
  assert.deepEqual(f, [500, 2000, 2500]);
  assert.equal(f.reduce((a, b) => a + b, 0), 5000);
});

test('commissionSchedule: never over-collects past the entitlement', () => {
  const f = commissionSchedule([100000, 100000], { total: 5000, capRate: 0.25, strategy: 'aggressive' });
  // 25% of 100k = 25k, but capped by remaining 5,000 then 0
  assert.deepEqual(f, [5000, 0]);
});

test('rollup aggregates', () => {
  assert.equal(rollup([1, 2, 3], 'sum'), 6);
  assert.equal(rollup([1, 2, 3], 'min'), 1);
  assert.equal(rollup([1, 2, 3], 'max'), 3);
  assert.equal(rollup([2, 4], 'avg'), 3);
  assert.equal(rollup(['1', 'x', '3'], 'count'), 2); // non-numeric dropped
  assert.equal(rollup([], 'sum'), 0);
});

test('round2 handles float fuzz', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(2500.005), 2500.01);
});
