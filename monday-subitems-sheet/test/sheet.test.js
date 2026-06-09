import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, pickColumns, parseTabsFromHtml, csvUrl } from '../lib/sheet.js';

test('parseCsv: simple rows', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
});

test('parseCsv: quoted field with embedded comma', () => {
  assert.deepEqual(
    parseCsv('Stage 1,"Build the API, then test it"\n'),
    [['Stage 1', 'Build the API, then test it']],
  );
});

test('parseCsv: doubled quotes become a literal quote', () => {
  assert.deepEqual(parseCsv('a,"she said ""hi"""'), [['a', 'she said "hi"']]);
});

test('parseCsv: CRLF line endings normalize to row breaks', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('parseCsv: quoted field spanning a newline', () => {
  assert.deepEqual(parseCsv('"line1\nline2",b'), [['line1\nline2', 'b']]);
});

test('parseCsv: trailing empty field preserved', () => {
  assert.deepEqual(parseCsv('a,b,\n'), [['a', 'b', '']]);
});

test('pickColumns: header detected by tokens (Hebrew), maps stage/description', () => {
  const rows = [
    ['שלב', 'תיאור המשימה'],
    ['Stage 1', 'Define the product'],
    ['Stage 2', 'Build an MVP'],
  ];
  assert.deepEqual(pickColumns(rows), [
    { stage: 'Stage 1', description: 'Define the product' },
    { stage: 'Stage 2', description: 'Build an MVP' },
  ]);
});

test('pickColumns: header detected by tokens (English)', () => {
  const rows = [
    ['Stage', 'Task'],
    ['Discovery', 'Talk to users'],
  ];
  assert.deepEqual(pickColumns(rows), [{ stage: 'Discovery', description: 'Talk to users' }]);
});

test('pickColumns: no header -> positional fallback col0=stage, col1=description', () => {
  // "Stage 1" must NOT be mistaken for a header (exact match, not substring).
  const rows = [
    ['Stage 1', 'Register the company'],
    ['Stage 2', 'Open a bank account'],
  ];
  assert.deepEqual(pickColumns(rows), [
    { stage: 'Stage 1', description: 'Register the company' },
    { stage: 'Stage 2', description: 'Open a bank account' },
  ]);
});

test('pickColumns: Hebrew data values containing שלב/משימה are kept, not dropped as a header', () => {
  const rows = [
    ['שלב ראשון', 'משימה: הגדרת מוצר'],
    ['שלב שני', 'גיוס משקיע'],
  ];
  assert.deepEqual(pickColumns(rows), [
    { stage: 'שלב ראשון', description: 'משימה: הגדרת מוצר' },
    { stage: 'שלב שני', description: 'גיוס משקיע' },
  ]);
});

test('pickColumns: drops fully-blank rows and rows missing a description', () => {
  const rows = [
    ['Stage', 'Task'],
    ['Stage 1', 'Real task'],
    ['', ''],
    ['Stage 2', ''], // no description -> dropped
  ];
  assert.deepEqual(pickColumns(rows), [{ stage: 'Stage 1', description: 'Real task' }]);
});

test('pickColumns: ambiguous first row (no clean stage+desc header) treated as data', () => {
  // Neither cell exactly matches a stage/desc header label -> positional, no skip.
  const rows = [
    ['Task status', 'Details'],
    ['Open', 'Do the thing'],
  ];
  assert.deepEqual(pickColumns(rows), [
    { stage: 'Task status', description: 'Details' },
    { stage: 'Open', description: 'Do the thing' },
  ]);
});

test('pickColumns: empty input -> empty list', () => {
  assert.deepEqual(pickColumns([]), []);
  assert.deepEqual(pickColumns([['', '']]), []);
});

test('csvUrl: builds the export-by-gid URL', () => {
  assert.equal(
    csvUrl('SHEET', '0'),
    'https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=0',
  );
});

test('parseTabsFromHtml: extracts name -> gid, decodes escapes, ignores pageUrl gid=', () => {
  // Mirrors the real htmlview markup: each tab is an items.push({name,pageUrl,gid}).
  // pageUrl contains "gid=0" (equals form) and \/ \x3d escapes that must NOT be
  // mistaken for the gid, and a tab name with a \/ escape to decode.
  const html = [
    'var items = [];',
    'items.push({name: "Pre-Seed", pageUrl: "https:\\/\\/d\\/X\\/htmlview\\/sheet?headers\\x3dtrue&gid=0", gid: "0",initialSheet: true});',
    'items.push({name: "מחקר יישומי", pageUrl: "https:\\/\\/d\\/X\\/sheet?gid=123", gid: "123"});',
    'items.push({name: "A\\/B", pageUrl: "...gid=99", gid: "7"});',
  ].join('\n');
  assert.deepEqual(
    [...parseTabsFromHtml(html).entries()],
    [['Pre-Seed', '0'], ['מחקר יישומי', '123'], ['A/B', '7']],
  );
});

test('parseTabsFromHtml: no tabs -> empty map', () => {
  assert.equal(parseTabsFromHtml('<html>no items here</html>').size, 0);
});
