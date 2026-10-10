import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo root, resolved from this file's location (not process.cwd()).
 * src/paths.ts (tsx) and dist/paths.js (node) both sit two levels below the root,
 * so the same relative hop works in dev, tests and production.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..', '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const SQL_DIR = path.join(ROOT_DIR, 'sql');
export const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');

export const RAW_CSV = path.join(DATA_DIR, 'raw', 'Case_Study_3_Pure_Insights_Monitoring.csv');
export const WAREHOUSE_PATH = path.join(DATA_DIR, 'warehouse.duckdb');
export const DQ_SUMMARY_PATH = path.join(DATA_DIR, 'dq_summary.json');
export const DOCS_DIR = path.join(ROOT_DIR, 'docs');
export const OPENAPI_PATH = path.join(DOCS_DIR, 'openapi.yaml');
