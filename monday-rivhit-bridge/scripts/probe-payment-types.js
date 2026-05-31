// Probe Rivhit's Payment.TypeList for this merchant.
// Useful for picking the numeric payment_type to send with a receipt-type
// Document.New (e.g. for חשבון קבלה / קבלה).
//
// Usage:  node scripts/probe-payment-types.js

import 'dotenv/config';
import { postRivhit } from '../lib/rivhit.js';

try {
  const data = await postRivhit('Payment.TypeList', {});
  const rows = data?.payment_type_list ?? data?.payment_types ?? data ?? [];
  console.log('Rivhit Payment.TypeList:');
  if (Array.isArray(rows)) {
    for (const r of rows) {
      console.log(`  ${String(r.payment_type ?? r.id ?? '?').padStart(3)}: ${r.payment_name ?? r.name ?? JSON.stringify(r)}`);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
} catch (e) {
  console.error('Payment.TypeList failed:', e.message);
}
