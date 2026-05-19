import 'dotenv/config';
import { fetchItemWithSubitems, findCol } from '../lib/monday.js';

const itemId = process.argv[2];
if (!itemId) {
  console.error('usage: node scripts/peek-row.js <item_id>');
  process.exit(2);
}

const item = await fetchItemWithSubitems(itemId);

const C = {
  customerId: process.env.COL_CUSTOMER_ID,
  customerName: process.env.COL_CUSTOMER_NAME,
  docType: process.env.COL_DOC_TYPE,
  issueDate: process.env.COL_ISSUE_DATE,
  comments: process.env.COL_COMMENTS,
  status: process.env.COL_STATUS,
  lastError: process.env.COL_LAST_ERROR,
  docNumber: process.env.COL_DOC_NUMBER,
  pdfLink: process.env.COL_PDF_LINK,
  subQty: process.env.SUBCOL_QTY,
  subPrice: process.env.SUBCOL_PRICE,
  subCatalog: process.env.SUBCOL_CATALOG,
};

console.log(`Item ${item.id}  "${item.name}"`);
console.log(`  Customer ID:   ${findCol(item, C.customerId)?.text || '(empty)'}`);
console.log(`  Customer Name: ${findCol(item, C.customerName)?.text || '(empty)'}`);
console.log(`  Document Type: ${findCol(item, C.docType)?.text || '(empty)'}`);
console.log(`  Issue Date:    ${findCol(item, C.issueDate)?.text || '(empty)'}`);
console.log(`  Comments:      ${findCol(item, C.comments)?.text || '(empty)'}`);
console.log(`  Status:        ${findCol(item, C.status)?.text || '(empty)'}`);
console.log(`  Document #:    ${findCol(item, C.docNumber)?.text || '(empty)'}`);
console.log(`  PDF Link:      ${findCol(item, C.pdfLink)?.text || '(empty)'}`);
console.log(`  Last Error:    ${findCol(item, C.lastError)?.text || '(empty)'}`);
console.log(`  ${item.subitems?.length ?? 0} subitem(s):`);
for (const s of item.subitems ?? []) {
  const q = findCol(s, C.subQty)?.text || '';
  const p = findCol(s, C.subPrice)?.text || '';
  const c = findCol(s, C.subCatalog)?.text || '';
  console.log(`    "${s.name}"  qty=${q || '(empty)'}  price=${p || '(empty)'}  cat=${c || '(empty)'}`);
}
