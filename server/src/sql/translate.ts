/*
 * Minimal Snowflake → DuckDB translation for the /sql suite.
 *
 * The files in /sql are written in Snowflake dialect and stay that way. Where DuckDB cannot run a
 * construct, one of the TRANSLATIONS below rewrites it, and only in code: comments and string
 * literals are never touched. After translating, any leftover Snowflake-only token in code is an
 * error naming the file, so a new construct fails loudly instead of half-working.
 * Every rule is listed in /sql/README.md (a test enforces that).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SQL_DIR } from '../paths.js';

export interface Translation {
  id: string;
  snowflake: string;
  duckdb: string;
  why: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

export const TRANSLATIONS: readonly Translation[] = [
  {
    id: 'ACCOUNT_USAGE_SCHEMA',
    snowflake: 'SNOWFLAKE.ACCOUNT_USAGE.<view>',
    duckdb: 'ACCOUNT_USAGE.<table>',
    why: 'DuckDB reads a 3-part name as catalog.schema.table; the simulation lives in a local ACCOUNT_USAGE schema',
    pattern: /\bSNOWFLAKE\.ACCOUNT_USAGE\b/gi,
    replace: () => 'ACCOUNT_USAGE',
  },
  {
    id: 'JSON_PATH',
    snowflake: 'TRY_PARSE_JSON(<col>):<key>::STRING',
    duckdb: "json_extract_string(TRY_CAST(<col> AS JSON), '$.<key>')",
    why: "DuckDB has no VARIANT ':' path syntax; TRY_CAST to JSON is NULL for empty or invalid tags, like TRY_PARSE_JSON",
    pattern: /\bTRY_PARSE_JSON\(\s*([A-Za-z_][\w.]*)\s*\):([A-Za-z_]\w*)::STRING\b/gi,
    replace: (_m, expr, key) => `json_extract_string(TRY_CAST(${expr} AS JSON), '$.${key}')`,
  },
  {
    id: 'TIMESTAMP_LTZ',
    snowflake: 'TIMESTAMP_LTZ',
    duckdb: 'TIMESTAMP',
    why: 'DuckDB has no TIMESTAMP_LTZ type; all simulated times are UTC, so a plain TIMESTAMP is equivalent',
    pattern: /\bTIMESTAMP_LTZ\b/gi,
    replace: () => 'TIMESTAMP',
  },
  {
    id: 'ARRAY_TYPE',
    snowflake: 'ARRAY (column type)',
    duckdb: 'VARCHAR[]',
    why: 'DuckDB lists are typed; both ARRAY columns (dq_flags, owner_history) hold strings',
    pattern: /\bARRAY\b/gi,
    replace: () => 'VARCHAR[]',
  },
];

/**
 * Tokens that must not survive translation in code segments: Snowflake-only syntax, plus FLOAT,
 * which DuckDB accepts but silently makes 4-byte (Snowflake FLOAT is 8-byte), so it would lose
 * precision instead of failing. FLOAT4 and REAL are 4-byte in both engines; FLOAT8 / DOUBLE are fine.
 */
const LEFTOVER_TOKENS: readonly { token: string; pattern: RegExp }[] = [
  { token: 'PARSE_JSON', pattern: /PARSE_JSON/i },
  { token: ':report_id', pattern: /:report_id\b/i },
  { token: 'TIMESTAMP_LTZ', pattern: /TIMESTAMP_LTZ/i },
  { token: 'SNOWFLAKE.', pattern: /\bSNOWFLAKE\./i },
  { token: 'FLOAT', pattern: /\b(FLOAT4?|REAL)\b/i },
];

export interface SqlSegment {
  kind: 'code' | 'comment' | 'string';
  text: string;
}

/**
 * Splits SQL into code, comment (`--…` and `/* … *\/`) and single-quoted string segments.
 * Strings use the standard '' escape; double-quoted identifiers stay in code. Concatenating the
 * segments' text always gives back the input.
 */
export function splitSql(sql: string): SqlSegment[] {
  const out: SqlSegment[] = [];
  let code = '';
  const flushCode = () => {
    if (code) out.push({ kind: 'code', text: code });
    code = '';
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      flushCode();
      out.push({ kind: 'comment', text: sql.slice(i, stop) });
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      flushCode();
      out.push({ kind: 'comment', text: sql.slice(i, stop) });
      i = stop;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const stop = Math.min(j + 1, sql.length);
      flushCode();
      out.push({ kind: 'string', text: sql.slice(i, stop) });
      i = stop;
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      code += sql.slice(i, stop);
      i = stop;
    } else {
      code += ch;
      i++;
    }
  }
  flushCode();
  return out;
}

/** Applies TRANSLATIONS to code segments, then rejects leftover Snowflake-only tokens. */
export function translateSnowflakeToDuckDb(sql: string, file: string): string {
  const translated = splitSql(sql)
    .map((seg) =>
      seg.kind === 'code'
        ? TRANSLATIONS.reduce(
            (text, t) =>
              // Replacer args are (match, ...groups, offset, input); none of the patterns use named groups.
              text.replace(t.pattern, (m: string, ...args: unknown[]) =>
                t.replace(m, ...(args.slice(0, -2) as string[])),
              ),
            seg.text,
          )
        : seg.text,
    )
    .join('');

  for (const seg of splitSql(translated)) {
    if (seg.kind !== 'code') continue;
    for (const { token, pattern } of LEFTOVER_TOKENS) {
      if (pattern.test(seg.text)) {
        throw new Error(
          `${file}: Snowflake syntax "${token}" has no DuckDB translation (add one to TRANSLATIONS ` +
            `and /sql/README.md, or use a portable form)`,
        );
      }
    }
  }
  return translated;
}

/** Reads /sql/<file> and returns it translated for DuckDB. */
export function loadSql(file: string): string {
  return translateSnowflakeToDuckDb(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'), file);
}
