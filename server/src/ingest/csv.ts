/** Column order of data/raw/Case_Study_3_Pure_Insights_Monitoring.csv. */
export const CSV_COLUMNS = [
  'report_id',
  'report_name',
  'owner_email',
  'last_refresh_status',
  'monthly_active_views',
  'snowflake_credits_consumed',
  'avg_load_time_sec',
  'aws_hosting_cost_usd',
  'query_count_last_30d',
  'concurrent_user_peak',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** One CSV data row, values exactly as written in the file. */
export type RawRow = Record<CsvColumn, string>;

/**
 * Minimal parser for this file's known format: header row, comma separated, no quoting.
 * Throws on a header mismatch, any quote character, or a wrong field count, so a change in the
 * source format fails loudly instead of misaligning columns. Array index = 0-based row position.
 */
export function parseCsv(text: string): RawRow[] {
  // A file re-saved by Excel starts with a UTF-8 BOM; it is not part of the header.
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const [header, ...body] = lines;
  if (header === undefined) throw new Error('CSV is empty');
  if (header !== CSV_COLUMNS.join(',')) {
    throw new Error(`Unexpected CSV header: ${header}`);
  }

  return body.map((line, i) => {
    if (line.includes('"'))
      throw new Error(`Quoted field on data row ${i}; parser does not support quoting`);
    const fields = line.split(',');
    if (fields.length !== CSV_COLUMNS.length) {
      throw new Error(`Data row ${i} has ${fields.length} fields, expected ${CSV_COLUMNS.length}`);
    }
    const row = {} as RawRow;
    CSV_COLUMNS.forEach((col, c) => {
      row[col] = fields[c] as string;
    });
    return row;
  });
}
