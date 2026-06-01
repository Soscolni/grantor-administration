// Stateful / cross-row calculations Monday's per-row formula columns can't do.
// Pure functions over plain numbers — no Monday dependency, fully unit-tested.

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Commission collected per installment ("פעימה"), the calc from the tender guide.
//
//   installments: ordered array of P (each installment amount paid to the client)
//   total:        total commission entitlement — the cap on the running sum
//   capRate:      max fraction collectable from a single installment (e.g. 0.25)
//   strategy:     'aggressive' — take up to capRate*P each, front-loaded, until
//                                the entitlement is reached, then 0.
//                 'proportional' — take a flat rate of each installment, where
//                                the rate is total / sum(P) so it sums to total.
//
// Returns an array of collected amounts, one per installment, rounded to agorot.
export function commissionSchedule(installments, { total, capRate = 0.25, strategy = 'aggressive' } = {}) {
  const ps = installments.map(Number);
  if (ps.some((p) => !Number.isFinite(p))) throw new Error('an installment amount is not numeric');
  if (!Number.isFinite(Number(total))) throw new Error('total commission is not numeric');
  const totalNum = Number(total);

  if (strategy === 'proportional') {
    const sum = ps.reduce((a, b) => a + b, 0);
    const rate = sum > 0 ? totalNum / sum : 0;
    return ps.map((p) => round2(rate * p));
  }

  // aggressive (the F = min(R, capRate * P) running rule)
  let r = totalNum;
  return ps.map((p) => {
    const f = Math.min(r, round2(capRate * p));
    r = round2(r - f);
    return f < 0 ? 0 : f;
  });
}

// Aggregate a set of values gathered across subitems / linked items — the
// "running total / cross-row" ability native formulas lack.
export function rollup(values, op) {
  const nums = values.map(Number).filter((n) => Number.isFinite(n));
  switch (op) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'min': return nums.length ? Math.min(...nums) : 0;
    case 'max': return nums.length ? Math.max(...nums) : 0;
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'count': return nums.length;
    default: throw new Error(`unknown rollup op "${op}"`);
  }
}
