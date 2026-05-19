// Rivhit expects DD/MM/YYYY everywhere a date appears.
// Monday and HTML <input type=date> both yield YYYY-MM-DD.
export function ymdToDmy(ymd) {
  if (!ymd) return '';
  const [y, m, d] = String(ymd).split('-');
  if (!y || !m || !d) return ymd;
  return `${d}/${m}/${y}`;
}

export function todayDmy() {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = now.getFullYear();
  return `${d}/${m}/${y}`;
}
