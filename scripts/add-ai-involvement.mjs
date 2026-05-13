// v0.10.2 Items 13a + 19b prereq: append parsed-field rows that route
// downstream triggers (data_handling, ai-governance, subprocessor) from
// the intake itself instead of regex-fishing the security questionnaire.
// `parseIntakeXlsx` auto-extracts every Field Key / Value pair into
// `inventory.parsed_fields`, so this is strictly a data change — no
// parser code touched. Values sourced from eval/dataset.json `input.*`
// to keep the materialized fixtures consistent with the dataset of
// record.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

const cases = [
  {
    id: 'case_001',
    fields: {
      ai_involvement: 'general',
      data_sensitivity: 'pii',
      subprocessor_region: 'EU',
    },
  },
  {
    id: 'case_002',
    fields: {
      ai_involvement: 'none',
      data_sensitivity: 'none',
      subprocessor_region: '',
    },
  },
  {
    id: 'case_003',
    fields: {
      ai_involvement: 'training_on_customer_data',
      data_sensitivity: 'restricted_pii',
      subprocessor_region: 'APAC',
    },
  },
];

for (const { id, fields } of cases) {
  const filePath = path.join(ROOT, 'cases', id, `${id}_intake.xlsx`);
  const buf = await fs.readFile(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  const headerIdx = rows.findIndex(
    (r) => Array.isArray(r) && r.includes('Field Key') && r.includes('Value')
  );
  if (headerIdx === -1) throw new Error(`No header row in ${filePath}`);
  const headers = rows[headerIdx];
  const keyIdx = headers.indexOf('Field Key');
  const valueIdx = headers.indexOf('Value');

  let mutated = false;
  for (const [key, value] of Object.entries(fields)) {
    const already = rows.some(
      (r) =>
        Array.isArray(r) &&
        String(r[keyIdx] ?? '').toLowerCase() === key.toLowerCase()
    );
    if (already) {
      console.log(`[${id}] ${key} already present — skipping`);
      continue;
    }
    const newRow = new Array(headers.length).fill(null);
    newRow[keyIdx] = key;
    newRow[valueIdx] = value;
    rows.push(newRow);
    mutated = true;
    console.log(`[${id}] appended ${key}=${value || '(empty)'}`);
  }

  if (!mutated) continue;
  const updatedSheet = XLSX.utils.aoa_to_sheet(rows);
  wb.Sheets[sheetName] = updatedSheet;
  XLSX.writeFile(wb, filePath);
}

console.log('Done.');
