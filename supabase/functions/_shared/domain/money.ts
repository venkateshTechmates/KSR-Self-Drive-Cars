// Money is stored as whole paise (integer) to avoid rounding errors (Section 8).

const rupeeFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const rupeeFormat2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "₹1,800" or "₹1,00,000" (Indian digit grouping); shows paise only when present. */
export function formatRupees(paise: number | null | undefined): string {
  const p = Math.round(Number(paise ?? 0));
  const sign = p < 0 ? '−' : '';
  const abs = Math.abs(p);
  const body = abs % 100 === 0 ? rupeeFormat.format(abs / 100) : rupeeFormat2.format(abs / 100);
  return `${sign}₹${body}`;
}

export const rupeesToPaise = (rupees: number): number => Math.round(rupees * 100);
export const paiseToRupees = (paise: number): number => paise / 100;

/** Parse a rupee amount typed by staff ("1,800", "₹ 1800.50"). Returns paise, or null if invalid. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return rupeesToPaise(Number(cleaned));
}

/** Rupee value suitable for an <input> (no symbol, no grouping). */
export function paiseToInput(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}
