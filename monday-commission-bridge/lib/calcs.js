// The commission math. Pure functions, no Monday dependency — copied from
// monday-calc-engine/lib/calcs.js so this bridge stays self-contained.

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Commission collected per installment ("פעימה"), the rule from the tender guide.
//
//   installments: ordered array of P (each installment amount paid to the client)
//   total:        total commission entitlement (= winning × commission rate) — the cap on the running sum
//   capRate:      max fraction collectable from a single installment (e.g. 0.25)
//
// Walks the installments in order applying F = min(R, capRate × P) and carrying
// the remaining R. Returns one collected amount per installment, rounded to agorot.
export function commissionSchedule(installments, { total, capRate = 0.25 } = {}) {
  const ps = installments.map(Number);
  if (ps.some((p) => !Number.isFinite(p))) throw new Error('an installment amount is not numeric');
  if (!Number.isFinite(Number(total))) throw new Error('total commission is not numeric');

  let r = Number(total);
  return ps.map((p) => {
    const f = Math.min(r, round2(capRate * p));
    r = round2(r - f);
    return f < 0 ? 0 : f;
  });
}
