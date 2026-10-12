// CSV export (RPT-06). Never pass KYC data or document numbers to this.
import { saveFile } from './download';

export type CsvValue = string | number | boolean | null | undefined;

const cell = (v: CsvValue) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralise spreadsheet formulas and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/** Downloads in a browser; the share sheet in the Android app. */
export function downloadCsv(filename: string, headers: string[], rows: CsvValue[][]): Promise<void> {
  return saveFile(new Blob(['﻿', toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' }), filename);
}
