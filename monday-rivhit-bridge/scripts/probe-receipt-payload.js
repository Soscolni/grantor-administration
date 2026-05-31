// Confirm the right payment payload shape with a single test.
import 'dotenv/config';
import { postRivhit, RivhitError } from '../lib/rivhit.js';

const today = (() => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
})();

const payload = {
  document_type: 2,
  customer_id: 97,
  issue_date: today,
  items: [{ description: 'probe', quantity: 1, price_nis: 100 }],
  payments: [{ payment_type: 9, amount_nis: 100 }],
};

try {
  const data = await postRivhit('Document.New', payload);
  console.log(`OK: document_number=${data.document_number}, link=${data.document_link}`);
} catch (e) {
  if (e instanceof RivhitError) {
    console.log(`FAIL: error_code=${e.errorCode}: ${e.clientMessage || e.message}`);
  } else {
    console.log(`FAIL: ${e.message}`);
  }
}
