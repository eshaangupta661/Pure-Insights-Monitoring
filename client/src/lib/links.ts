/** Where the repo's SQL suite and docs live on GitHub (override with VITE_REPO_URL). */
const REPO_URL: string =
  (import.meta.env.VITE_REPO_URL as string | undefined) ??
  'https://github.com/eshaangupta661/Pure-Insights-Monitoring';
const BRANCH = 'main';

export const sqlFileUrl = (file: string): string => `${REPO_URL}/blob/${BRANCH}/sql/${file}`;
export const docUrl = (file: string): string => `${REPO_URL}/blob/${BRANCH}/docs/${file}`;
