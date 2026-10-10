import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/db.js';
import { SQL_DIR } from '../../src/paths.js';
import { paramDrift } from '../../src/sql/params.js';
import {
  TRANSLATIONS,
  loadSql,
  splitSql,
  translateSnowflakeToDuckDb,
} from '../../src/sql/translate.js';

const translate = (sql: string) => translateSnowflakeToDuckDb(sql, 'fixture.sql');

describe('splitSql', () => {
  it('separates code, comments and strings and round-trips the input', () => {
    const sql = `SELECT 'a''b' AS s, x -- note 'quoted'\n/* block\n'x' */ FROM "we--ird" t`;
    const segs = splitSql(sql);
    expect(segs.map((s) => s.text).join('')).toBe(sql);
    expect(segs.filter((s) => s.kind === 'string').map((s) => s.text)).toEqual(["'a''b'"]);
    expect(segs.filter((s) => s.kind === 'comment').map((s) => s.text)).toEqual([
      "-- note 'quoted'",
      "/* block\n'x' */",
    ]);
    // Double-quoted identifiers stay in code; their content is not a comment.
    expect(segs.at(-1)).toEqual({ kind: 'code', text: ' FROM "we--ird" t' });
  });
});

describe('translateSnowflakeToDuckDb', () => {
  it('ACCOUNT_USAGE_SCHEMA: drops the SNOWFLAKE database prefix', () => {
    expect(translate('SELECT * FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q')).toBe(
      'SELECT * FROM ACCOUNT_USAGE.QUERY_HISTORY q',
    );
    expect(translate('CREATE SCHEMA IF NOT EXISTS SNOWFLAKE.ACCOUNT_USAGE;')).toBe(
      'CREATE SCHEMA IF NOT EXISTS ACCOUNT_USAGE;',
    );
  });

  it('JSON_PATH: rewrites the VARIANT path to json_extract_string', () => {
    expect(translate('SELECT TRY_PARSE_JSON(q.QUERY_TAG):report_id::STRING AS report_id')).toBe(
      "SELECT json_extract_string(TRY_CAST(q.QUERY_TAG AS JSON), '$.report_id') AS report_id",
    );
    expect(translate('try_parse_json( tag ):team::string')).toBe(
      "json_extract_string(TRY_CAST(tag AS JSON), '$.team')",
    );
  });

  it('TIMESTAMP_LTZ and ARRAY_TYPE: map column types', () => {
    expect(translate('CREATE TABLE t (a TIMESTAMP_LTZ NOT NULL, b ARRAY NOT NULL)')).toBe(
      'CREATE TABLE t (a TIMESTAMP NOT NULL, b VARCHAR[] NOT NULL)',
    );
    // ARRAY_* functions are not the ARRAY type.
    expect(translate('SELECT ARRAY_SIZE(x) FROM t')).toBe('SELECT ARRAY_SIZE(x) FROM t');
  });

  describe('leaves SQL unchanged when there is nothing to translate', () => {
    it.each([
      ['portable SQL', 'SELECT COUNT_IF(x > 1)::INTEGER AS n, MEDIAN(y) FROM t QUALIFY 1 = 1'],
      [
        '8-byte floats, and FLOAT only in a comment, a string or an identifier',
        "SELECT x::DOUBLE, y::FLOAT8, 'FLOAT' AS s, real_cost, float_col FROM t -- never ::FLOAT",
      ],
      [
        'tokens inside a line comment',
        'SELECT 1 -- TRY_PARSE_JSON(QUERY_TAG):report_id::STRING from SNOWFLAKE.ACCOUNT_USAGE, TIMESTAMP_LTZ, ARRAY',
      ],
      [
        'tokens inside a block comment',
        '/* PARSE_JSON(x):report_id\n   SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY\n   TIMESTAMP_LTZ */ SELECT 1',
      ],
      [
        'tokens inside string literals',
        `SELECT 'SNOWFLAKE.' AS a, '{"report_id":"RPT_200"}' AS b, 'x:report_id TIMESTAMP_LTZ ARRAY' AS c, 'it''s PARSE_JSON' AS d`,
      ],
    ])('%s', (_name, sql) => {
      expect(translate(sql)).toBe(sql);
    });

    it('translates code but not the comment on the same line', () => {
      expect(
        translate('START_TIME TIMESTAMP_LTZ -- was TIMESTAMP_LTZ in SNOWFLAKE.ACCOUNT_USAGE'),
      ).toBe('START_TIME TIMESTAMP -- was TIMESTAMP_LTZ in SNOWFLAKE.ACCOUNT_USAGE');
    });
  });

  describe('throws, naming the file, when Snowflake-only syntax would survive', () => {
    it.each([
      [
        'strict PARSE_JSON path',
        'SELECT PARSE_JSON(QUERY_TAG):report_id::STRING FROM t',
        'PARSE_JSON',
      ],
      [
        'TRY_PARSE_JSON without the ::STRING cast',
        'SELECT TRY_PARSE_JSON(QUERY_TAG):report_id FROM t',
        'PARSE_JSON',
      ],
      ['a bare VARIANT path', 'SELECT v:report_id FROM t', ':report_id'],
      ['another SNOWFLAKE schema', 'SELECT * FROM SNOWFLAKE.ORGANIZATION_USAGE.X', 'SNOWFLAKE.'],
      ['TIMESTAMP_LTZ inside an identifier', 'SELECT col_TIMESTAMP_LTZ FROM t', 'TIMESTAMP_LTZ'],
      // DuckDB would accept these but make them 4-byte: precision loss, not an error.
      ['a ::FLOAT cast', 'SELECT credits::FLOAT AS c FROM t', 'FLOAT'],
      ['a FLOAT column', 'CREATE TABLE t (x FLOAT NOT NULL)', 'FLOAT'],
      ['CAST(... AS REAL)', 'SELECT CAST(x AS real) FROM t', 'FLOAT'],
      ['FLOAT4', 'SELECT x::FLOAT4 FROM t', 'FLOAT'],
    ])('%s', (_name, sql, token) => {
      expect(() => translateSnowflakeToDuckDb(sql, '99_example.sql')).toThrow(
        new RegExp(`^99_example\\.sql: Snowflake syntax "${token.replace('.', '\\.')}"`),
      );
    });
  });
});

describe('the /sql suite', () => {
  const files = fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('has the numbered files 00–08', () => {
    expect(files.map((f) => f.slice(0, 2))).toEqual([
      '00',
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
    ]);
  });

  it.each(files)('%s has a header and translates cleanly', (file) => {
    const text = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    for (const label of ['Purpose', 'Inputs', 'Outputs', 'Assumptions']) {
      expect(text).toMatch(new RegExp(`^-- ${label}\\s*:`, 'm'));
    }
    expect(() => loadSql(file)).not.toThrow();
  });

  it('cost SQL (03–08) never reads the uncleaned credits column', () => {
    for (const file of files.filter((f) => f >= '03')) {
      const text = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
      expect(text, file).not.toMatch(/snowflake_credits_consumed/i);
    }
  });

  it('lists every translation in sql/README.md', () => {
    const readme = fs.readFileSync(path.join(SQL_DIR, 'README.md'), 'utf8');
    for (const t of TRANSLATIONS) expect(readme).toContain(`\`${t.id}\``);
  });
});

describe('00_setup_parameters.sql matches config.ts', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openDb(':memory:');
    await db.conn.run(loadSql('00_setup_parameters.sql'));
  });
  afterAll(() => closeDb(db));

  it('reports no drift', async () => {
    expect(await paramDrift(db.conn)).toEqual([]);
  });

  it('names a drifted value, an unknown column and changed markers', async () => {
    await db.conn.run(
      'ALTER TABLE PARAMS ADD COLUMN surprise INTEGER DEFAULT 1; ' +
        'UPDATE PARAMS SET simulated_overhead_rate = 0.2; ' +
        "INSERT INTO PARAM_ORPHAN_MARKERS VALUES ('none');",
    );
    expect(await paramDrift(db.conn)).toEqual([
      'simulated_overhead_rate: sql=0.2 config=0.15',
      'surprise: in PARAMS but not in config.ts',
      'orphan markers: sql=["","nan","none","orphaned_report"] config=["","nan","orphaned_report"]',
    ]);
  });
});
