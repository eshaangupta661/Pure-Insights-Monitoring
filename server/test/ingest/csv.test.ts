import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, parseCsv } from '../../src/ingest/csv.js';
import {
  addDays,
  normalizeOwner,
  normalizeRefreshStatus,
  toSnapshotRow,
} from '../../src/ingest/normalize.js';

const HEADER = CSV_COLUMNS.join(',');
const LINE = 'RPT_200,Analytics Dashboard 1,nan,SUCCESS,186,857.88,44.8,75.51,12825,142';

describe('parseCsv', () => {
  it('parses rows as raw strings (CRLF tolerant, trailing newline ignored)', () => {
    const rows = parseCsv(`${HEADER}\r\n${LINE}\r\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      report_id: 'RPT_200',
      owner_email: 'nan',
      avg_load_time_sec: '44.8',
    });
  });
  it('strips a leading UTF-8 BOM before reading the header', () => {
    const BOM = String.fromCharCode(0xfeff);
    const rows = parseCsv(`${BOM}${HEADER}
${LINE}
`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.report_id).toBe('RPT_200');
  });
  it('rejects an unexpected header', () => {
    expect(() => parseCsv(`id,name\n${LINE}`)).toThrow(/header/);
  });
  it('rejects quoted fields', () => {
    expect(() => parseCsv(`${HEADER}\n"RPT_200",x,a,SUCCESS,1,1,1,1,1,1`)).toThrow(/Quoted/);
  });
  it('rejects a wrong field count', () => {
    expect(() => parseCsv(`${HEADER}\nRPT_200,x,a,SUCCESS,1,1,1,1,1`)).toThrow(/9 fields/);
  });
});

describe('normalize', () => {
  it('normalizes owner placeholders to null and trims emails', () => {
    expect(normalizeOwner('nan')).toBeNull();
    expect(normalizeOwner('ORPHANED_REPORT')).toBeNull();
    expect(normalizeOwner(' user_1@company.com ')).toBe('user_1@company.com');
  });
  it('lowercases owner emails and matches orphan markers case-insensitively', () => {
    expect(normalizeOwner('User_3@Company.com')).toBe('user_3@company.com');
    expect(normalizeOwner(' Orphaned_Report ')).toBeNull();
    expect(normalizeOwner(' NaN ')).toBeNull();
  });
  it('trims and uppercases refresh status', () => {
    expect(normalizeRefreshStatus(' success ', 0)).toBe('SUCCESS');
    expect(normalizeRefreshStatus('Timed_Out', 0)).toBe('TIMED_OUT');
  });
  it('fails ingest on an unknown refresh status', () => {
    expect(() => normalizeRefreshStatus('PENDING', 7)).toThrow(
      'Row 7: unknown last_refresh_status "PENDING" (expected one of SUCCESS, FAILED, TIMED_OUT, UNKNOWN)',
    );
    const [raw] = parseCsv(`${HEADER}
${LINE}`);
    expect(() => toSnapshotRow({ ...raw!, last_refresh_status: 'PENDING' }, 0, 100)).toThrow(
      /unknown last_refresh_status/,
    );
  });
  it('adds days across a month boundary in UTC', () => {
    expect(addDays('2026-09-21', 19)).toBe('2026-10-10');
  });
  it('derives snapshot index and date from the row position', () => {
    const [raw] = parseCsv(`${HEADER}\n${LINE}`);
    const r = toSnapshotRow(raw!, 250, 100);
    expect(r).toMatchObject({
      snapshot_idx: 2,
      snapshot_date: '2026-09-23',
      owner_email: null,
      monthly_active_views: 186,
    });
  });
  it('rejects non-numeric and non-integer values', () => {
    const [raw] = parseCsv(`${HEADER}\n${LINE}`);
    expect(() => toSnapshotRow({ ...raw!, avg_load_time_sec: 'abc' }, 0, 100)).toThrow(
      /not a number/,
    );
    expect(() => toSnapshotRow({ ...raw!, monthly_active_views: '1.5' }, 0, 100)).toThrow(
      /not an integer/,
    );
  });
});
