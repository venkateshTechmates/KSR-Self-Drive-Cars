// Parsers for the PostgREST syntax the web app uses:
//   select strings:  "*, car:cars(id, display_name), booking_events(at, note)"
//   logic trees:     "status.in.(a,b),and(status.eq.active,return_due_at.lt.\"2026-…\")"
import { ApiError } from '../errors.ts';

export interface SelectNode {
  star: boolean;
  /** Plain columns: [outputName, column]. */
  columns: Array<{ as: string; column: string }>;
  embeds: EmbedNode[];
}

export interface EmbedNode {
  /** Key in the output row. */
  as: string;
  table: string;
  /** Optional foreign-key hint (table!hint(...)), a column name. */
  hint: string | null;
  select: SelectNode;
}

const bad = (message: string): never => {
  throw new ApiError(message, 'invalid_query', { status: 400, pgCode: 'PGRST100' });
};

/** Split on commas at nesting depth 0, respecting double-quoted strings. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      cur += ch;
      if (ch === '\\' && i + 1 < s.length) {
        cur += s[++i];
      } else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) bad('Unbalanced parentheses in query.');
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (depth !== 0 || quoted) bad('Unbalanced parentheses or quotes in query.');
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function parseSelect(input: string | undefined | null): SelectNode {
  const node: SelectNode = { star: false, columns: [], embeds: [] };
  const src = (input ?? '*').trim() || '*';
  for (const item of splitTop(src)) {
    if (item === '*') {
      node.star = true;
      continue;
    }
    const embed = /^(?:([a-z_][a-z0-9_]*)\s*:\s*)?([a-z_][a-z0-9_]*)(?:!([a-z_][a-z0-9_]*))?\s*\(([\s\S]*)\)$/.exec(item);
    if (embed) {
      node.embeds.push({ as: embed[1] ?? embed[2], table: embed[2], hint: embed[3] ?? null, select: parseSelect(embed[4]) });
      continue;
    }
    const col = /^(?:([a-z_][a-z0-9_]*)\s*:\s*)?([a-z_][a-z0-9_]*)(?:::[a-z]+)?$/.exec(item);
    if (!col) bad(`Can't read select item "${item}".`);
    node.columns.push({ as: col![1] ?? col![2], column: col![2] });
  }
  return node;
}

export type LogicNode =
  | { type: 'and' | 'or'; negate: boolean; items: LogicNode[] }
  | { type: 'cond'; column: string; op: string; value: string; negate: boolean };

/** Remove surrounding double quotes and unescape \" and \\. */
export function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return v;
}

function parseItem(item: string): LogicNode {
  const group = /^(not\.)?(and|or)\(([\s\S]*)\)$/.exec(item);
  if (group) return { type: group[2] as 'and' | 'or', negate: Boolean(group[1]), items: splitTop(group[3]).map(parseItem) };
  // column.[not.]op.value  (value may contain dots, e.g. timestamps)
  const m = /^([a-z_][a-z0-9_]*)\.(not\.)?([a-z]+)\.([\s\S]*)$/.exec(item);
  if (!m || !IDENT.test(m[1])) bad(`Can't read filter "${item}".`);
  return { type: 'cond', column: m![1], negate: Boolean(m![2]), op: m![3], value: m![4] };
}

/** The argument of `.or("…")`: a comma-separated list combined with OR. */
export function parseOrList(input: string): LogicNode {
  const items = splitTop(input.trim());
  if (!items.length) bad('Empty filter.');
  return { type: 'or', negate: false, items: items.map(parseItem) };
}

/** Values of an `in.(a,"b,c",d)` list. */
export function parseInList(value: string): string[] {
  const m = /^\(([\s\S]*)\)$/.exec(value.trim());
  if (!m) bad(`Expected a list in parentheses, got "${value}".`);
  return m![1].trim() === '' ? [] : splitTop(m![1]).map(unquote);
}
