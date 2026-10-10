import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_DIST, DATA_DIR, ROOT_DIR, SQL_DIR } from '../src/paths.js';

describe('paths', () => {
  it('resolves ROOT_DIR from the module location, independent of cwd', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'package.json'))).toBe(true);
    expect(DATA_DIR).toBe(path.join(ROOT_DIR, 'data'));
    expect(SQL_DIR).toBe(path.join(ROOT_DIR, 'sql'));
    expect(CLIENT_DIST).toBe(path.join(ROOT_DIR, 'client', 'dist'));
  });
});
