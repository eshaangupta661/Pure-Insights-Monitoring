import type { RouteDef } from '../http/route.js';
import { adminRoutes } from './admin.js';
import { alertRoutes } from './alerts.js';
import { authRoutes } from './auth.js';
import { costRoutes } from './costs.js';
import { reportRoutes } from './reports.js';

/** Every /api/v1 endpoint. The OpenAPI document and the access-matrix test read this list. */
export const ALL_ROUTES: readonly RouteDef[] = [
  ...authRoutes,
  ...reportRoutes,
  ...costRoutes,
  ...alertRoutes,
  ...adminRoutes,
];
