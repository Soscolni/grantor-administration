import 'dotenv/config';
import { postRivhit } from '../lib/rivhit.js';

const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (ids.length === 0) {
  console.error('usage: node scripts/probe-customers.js <id> [<id> ...]');
  process.exit(2);
}

for (const id of ids) {
  try {
    const c = await postRivhit('Customer.Get', { customer_id: id });
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.customer_name || '(no name)';
    console.log(`  ${id} -> OK: ${name}`);
  } catch (e) {
    console.log(`  ${id} -> ERR: ${e.clientMessage || e.message}`);
  }
}
