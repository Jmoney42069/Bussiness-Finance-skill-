// Reads and parses CSV and Excel financial data files. Handles standard formats + Rabobank/ING bank exports.

import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

/**
 * Parse any supported file (.csv, .xlsx, .xls) and return normalized rows.
 * Automatically handles Rabobank and ING bank export formats.
 */
export function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return parseXlsxFile(filePath);
  return parseCsvFile(filePath);
}

/**
 * Parse a CSV file. Auto-detects delimiter, trims headers.
 */
export function parseCsvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const result = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/[\s\/()-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''),
  });
  if (result.errors.length > 0) {
    const fatal = result.errors.filter((e) => e.type === 'Delimiter' || e.type === 'Abort');
    if (fatal.length > 0) throw new Error(`CSV parse error: ${fatal[0].message}`);
  }
  return normalizeRows(result.data, result.meta.fields ?? []);
}

/**
 * Parse an Excel (.xlsx / .xls) file. Uses first sheet.
 */
export function parseXlsxFile(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (rawRows.length === 0) return { rows: [], fields: [] };

  const normalizeHeader = (h) =>
    String(h).trim().toLowerCase().replace(/[\s\/()-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

  const fields = Object.keys(rawRows[0]).map(normalizeHeader);
  const rows = rawRows.map(row => {
    const out = {};
    Object.entries(row).forEach(([k, v]) => { out[normalizeHeader(k)] = v; });
    return out;
  });

  return normalizeRows(rows, fields);
}

/**
 * Normalize rows after parsing:
 * - Handles ING "Af Bij" column: converts to signed amounts.
 * - Handles Rabobank sign convention (bedrag is already signed).
 * - Adds unified `_amount`, `_date`, `_description` aliases for tools.
 */
function normalizeRows(rows, fields) {
  const afBijCol = fields.find(f => f === 'af_bij' || f === 'af bij' || f === 'af_bij');
  const amtCol   = detectAmountColumn(fields);

  if (afBijCol && amtCol) {
    // ING format: amount is always positive, "Af Bij" tells direction
    rows = rows.map(row => {
      const direction = String(row[afBijCol] ?? '').trim().toLowerCase();
      const raw = String(row[amtCol] ?? '').replace(',', '.');
      const amt = parseFloat(raw) || 0;
      return { ...row, [amtCol]: direction === 'af' ? -Math.abs(amt) : Math.abs(amt) };
    });
  }

  // Normalize ING-style YYYYMMDD integer dates (e.g., 20260103 → "2026-01-03")
  const dtCol = detectDateColumn(fields);
  if (dtCol) {
    rows = rows.map(row => {
      const v = row[dtCol];
      if (typeof v === 'number' && v >= 20000000 && v <= 29991231) {
        const s = String(v);
        return { ...row, [dtCol]: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` };
      }
      return row;
    });
  }

  // Alias non-standard amount column to 'bedrag' for cross-file compatibility (e.g., ING bedrag_eur)
  if (amtCol && amtCol !== 'bedrag') {
    rows = rows.map(row => ({ ...row, bedrag: row[amtCol] }));
    if (!fields.includes('bedrag')) fields = [...fields, 'bedrag'];
  }

  return { rows, fields };
}

/**
 * Detect which column likely holds transaction amounts.
 * Covers standard, Rabobank, and ING column naming.
 */
export function detectAmountColumn(fields) {
  const priority = [
    'bedrag',          // standard NL
    'bedrag_eur',      // ING variant
    'amount',          // English
    'waarde',
    'value',
    'sum',
    'totaal',
    'debet',
    'credit',
  ];
  // Exact match first
  for (const name of priority) {
    if (fields.includes(name)) return name;
  }
  // Partial match fallback
  return fields.find(f => priority.some(c => f.includes(c))) ?? null;
}

/**
 * Detect which column holds dates.
 */
export function detectDateColumn(fields) {
  const priority = ['datum', 'date', 'rentedatum', 'boekingsdatum', 'posting_date', 'transaction_date', 'valuedate'];
  for (const name of priority) {
    if (fields.includes(name)) return name;
  }
  return fields.find(f => priority.some(c => f.includes(c))) ?? null;
}

/**
 * Detect which column holds descriptions.
 * Covers standard, Rabobank (naam_tegenpartij, omschrijving-1) and ING (naam_omschrijving, mededelingen).
 */
export function detectDescriptionColumn(fields) {
  const priority = [
    'omschrijving',
    'naam_omschrijving',    // ING: "Naam / Omschrijving"
    'mededelingen',         // ING memo field
    'naam_tegenpartij',     // Rabobank
    'description',
    'naam',
    'name',
    'merchant',
    'label',
    'memo',
    'omschrijving_1',       // Rabobank "Omschrijving-1"
  ];
  for (const name of priority) {
    if (fields.includes(name)) return name;
  }
  return fields.find(f => priority.some(c => f.includes(c))) ?? null;
}

/**
 * Merge rows from multiple files into a single dataset.
 * Returns { rows, fields } where fields is the union of all column names.
 */
export function mergeFiles(filePaths) {
  let allRows = [];
  const fieldSet = new Set();

  for (const fp of filePaths) {
    const { rows, fields } = parseFile(fp);
    fields.forEach(f => fieldSet.add(f));
    allRows = allRows.concat(rows);
  }

  // Sort by date if available
  const fields = [...fieldSet];
  const dateCol = detectDateColumn(fields);
  if (dateCol) {
    allRows.sort((a, b) => new Date(a[dateCol]) - new Date(b[dateCol]));
  }

  return { rows: allRows, fields };
}
