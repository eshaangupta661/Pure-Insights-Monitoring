# REST API

Base path `/api/v1`. JSON everywhere. The full contract is [`openapi.yaml`](openapi.yaml)
(OpenAPI 3.0). It is generated from the same route declarations and zod schemas the server
validates with (`npm run openapi`), and a test fails if the committed file drifts. Interactive
docs are at **`/api/docs`** (Swagger UI) and the raw spec at `/api/openapi.json`.

## Authentication

|             |                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign in     | `POST /api/v1/auth/login` `{ "email", "password" }` → `{ "user": { "email", "role" }, "expiresAt" }`                                                                                       |
| Session     | The JWT (HS256, 8 h) is set in the **`pic_token` cookie**: `HttpOnly`, `SameSite=Lax`, `Secure` in production. It is **never returned in a response body**, so page scripts can't read it. |
| Alternative | `Authorization: Bearer <jwt>` (curl, scripts). When both are sent, the header wins.                                                                                                        |
| Who am I    | `GET /api/v1/auth/me` → `{ "email", "role" }`                                                                                                                                              |
| Rate limit  | 20 login attempts per client IP per minute, then `429 RATE_LIMITED` with `Retry-After`                                                                                                     |
| Sign out    | `POST /api/v1/auth/logout` → 204, clears the cookie                                                                                                                                        |

The email is trimmed and lowercased before lookup. Owner scoping compares emails exactly, and
ingest stores owner emails the same way. A wrong password and an unknown email get the same
`401 INVALID_CREDENTIALS`, and both cost one bcrypt comparison. The role is re-read from the
account on every request, so a token can't claim a role its account doesn't have.

**Signing key.** `JWT_SECRET` must be at least 32 characters and is required when
`NODE_ENV=production` (Render generates one). Without it, outside tests, each process signs with
a fresh random key and logs a warning: sessions end on restart, but no published fallback key
exists that could be used to forge tokens.

**Behind Render's proxy.** The app trusts exactly one proxy hop (`trust proxy` = 1), so the login
limiter sees the real client IP, and a client can't dodge it by adding its own
`X-Forwarded-For` entries. The Origin check reads the `Host` header, which the proxy passes
through, and the cookie's `Secure` flag is set from configuration rather than inferred from the
request, so neither depends on forwarded headers. Tests cover both through simulated proxy
headers.

**Swagger UI:** open `/api/docs`, run `POST /auth/login` with one of the demo accounts, and every
later "Try it out" call carries the session cookie automatically (same origin). Nothing needs
to go in the Authorize dialog.

**CSRF.** No GET changes state. In production, POST, PATCH, PUT and DELETE are rejected with
`403 BAD_ORIGIN` if the `Origin` header names a different host. They are also rejected if there
is no `Origin` but the session cookie is present. Requests that authenticate only with a Bearer
header and send no Origin (curl) are allowed, because a cross-site page can't set that header.

```bash
curl -c jar -H 'Content-Type: application/json' \
     -d '{"email":"user_3@company.com","password":"Owner@123"}' \
     https://<host>/api/v1/auth/login
curl -b jar 'https://<host>/api/v1/reports?pageSize=5'
```

## Roles and access

| endpoint                                                                               | admin |    owner    |       viewer        | anonymous |
| -------------------------------------------------------------------------------------- | :---: | :---------: | :-----------------: | :-------: |
| `POST /auth/login`, `POST /auth/logout`                                                |   ✓   |      ✓      |          ✓          |     ✓     |
| `GET /auth/me`, `/overview`, `/reports`, `/reports/:id`, `/data-quality`, `/alerts`    |   ✓   | own reports | ✓ (no per-report $) |    401    |
| `GET /costs/reports`, `/costs/unit-economics`, `/costs/anomalies`, `/costs/chargeback` |   ✓   | own reports |   aggregates only   |    401    |
| `GET /costs/chargeback?view=point_in_time`                                             |   ✓   |     403     |   aggregates only   |    401    |
| `PATCH /reports/:id/owner`                                                             |   ✓   |     403     |         403         |    401    |
| `POST /alerts/:id/ack`                                                                 |   ✓   | own alerts  |         403         |    401    |
| `GET/POST /admin/replay`, `POST /admin/incidents`, `GET /admin/audit-log`              |   ✓   |     403     |         403         |    401    |

`test/api/access-matrix.test.ts` checks every endpoint × {anonymous, viewer, owner, admin}
against this table, written out independently of the code. A route missing from the table also
fails that test.

### Owner scoping (in SQL)

An owner sees only reports whose **current owner** is their email. "Current owner" is the
latest snapshot's owner, unless an admin override exists (view `REPORT_CURRENT_OWNER`,
`sql/01_schema.sql`). The filter is part of every query (`WHERE o.current_owner = $n`, with the
email as a bound parameter), including the `COUNT(*)` behind `total`. Nothing is filtered after
fetching. Every repository method takes the caller's `Scope` as a required argument.

- A report outside the scope is **404**, the same as one that doesn't exist, so its existence
  isn't revealed.
- Shares (`shareOfTotal`, `shareOfTotalCost`) are computed over the rows in scope. An owner's
  shares sum to 1 and reveal nothing about the portfolio total.
- Chargeback: an owner gets only their own line, and only `view=current` (their default).
  `view=point_in_time` is **403 for owners**. That view is an accounting record: it charges each
  past snapshot to whoever owned it then. With 7–13 owners per report, user_3's point-in-time
  line spans dozens of reports they no longer own, so showing it would break the rule above.
  Making it admin-only keeps "owners see only reports they currently own" without exceptions.
  Viewers still get its redacted counts.
- Alerts live in memory, not SQL. The same `Scope` filters them against the current owner map,
  so an override moves a report's alerts too.

### Viewer redaction (fail-closed)

Viewers get every list, but without per-report money or credits. Each route a viewer can reach
declares a viewer response schema (`Viewer*` in the spec), and the viewer's response is always
parsed through it. zod drops every key the schema doesn't list, so a cost column added to a
query later is hidden from viewers by default. A route that viewers can reach and that lacks a
viewer schema fails at startup; this includes public routes, since a signed-in viewer can call
them too. As a last guard, if a viewer ever reaches a route definition with no viewer schema,
the server returns 500 rather than the unredacted response. `test/api/viewer-redaction.test.ts`
walks every viewer GET response as a second check. It fails on any key matching
`cost|credit|usd|share|robustz|logz` outside `totals`.

- `totals` objects hold portfolio aggregates, which viewers may see.
- Sorting by a cost column would reveal cost rankings, so viewers get **403** for `sort=cost` /
  `sort=costPerView`. Their default sort is by report id (or owner, on chargeback).
- For the same reason, viewers get `/costs/anomalies` sections ordered by report and snapshot,
  not most-expensive-first. Their rows also omit the z-scores (`robustZ`, `awsLogZ`): each is a
  fixed transform of log cost per view, so together with `views` it would reveal cost.

## Conventions

**Errors** are always `{ "error": { "code": "…", "message": "…" } }`.

| status | code                                      | when                                                                                    |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`                        | query, path or body fails its schema; the message names the field (`query.pageSize: …`) |
| 400    | `BAD_REQUEST`                             | malformed JSON                                                                          |
| 401    | `UNAUTHENTICATED` / `INVALID_CREDENTIALS` | no valid session / wrong login                                                          |
| 403    | `FORBIDDEN` / `BAD_ORIGIN`                | role not allowed, or viewer cost sort / CSRF check                                      |
| 404    | `NOT_FOUND`                               | unknown route, or a resource outside your scope                                         |
| 409    | `CONFLICT`                                | acknowledging a resolved alert                                                          |
| 429    | `RATE_LIMITED`                            | too many logins from one IP, or the per-cycle incident limit                            |
| 500    | `INTERNAL`                                | anything else (logged server-side)                                                      |

**Pagination:** `?page=` (1-based, default 1) and `?pageSize=` (1–100, default 25). The response
is `{ items, page, pageSize, total }`, where `total` comes from a separate `COUNT(*)`. A page
past the end returns `items: []` with the real `total`. Cost lists add `totals`.

**Ordering:** lists sort by a whitelisted key (`sort`, `order`) and then by a unique column, so
pages never overlap.

**Money** is unrounded USD (`…Usd`), and credits are metered Snowflake credits. Rounding is the
client's job. `null` means unknown: zero views (DQ05), or quarantined negative credits (DQ02).

**Time:** reports and overview describe the replay's **current snapshot**. The tick advances
every 10 s; snapshot `i` is the date `2026-09-21 + i`. Ownership and cost totals span all 20
snapshots.

## Endpoints

### Reports and overview

- `GET /overview` returns KPIs for the current snapshot over the caller's scope: refresh-status
  counts, slow and critical-slow counts, average and max load time, views, active alert counts
  by severity, and `totals` (attributed Snowflake cost over all snapshots, plus this snapshot's
  Snowflake and AWS cost).
- `GET /reports?q=&status=&orphaned=&slow=&sort=&order=&page=&pageSize=`
  - `q`: substring of id, name or current owner.
  - `status`: `SUCCESS | FAILED | TIMED_OUT | UNKNOWN`.
  - `orphaned` / `slow`: `true | false`. Slow means > 15 s at this snapshot.
  - `sort`: `reportId | loadTime | views | status`.
- `GET /reports/:id` returns the summary plus the 20-snapshot `history` (that snapshot's owner,
  status, latency, views, DQ flags and cost), `ownerHistory`, any `override`, and the report's
  `cost` over all snapshots.
- `PATCH /reports/:id/owner` (admin) takes `{ "ownerEmail": "x@y.com" | null, "reason"?: "…" }`
  and returns the updated `ReportDetail`. See [Owner overrides](#owner-overrides-and-audit-log).
- `GET /data-quality` returns the DQ01–DQ09 counts and sample report ids over every snapshot of
  the reports in scope; unscoped, they equal `data/dq_summary.json`. It also returns the
  quarantine count and `checks`: PASS/FAIL of the SQL re-computation in `/sql/02`.

### Costs (`/sql` 04–07)

| endpoint                                                             | rows                                   | notes                                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /costs/reports?sort=cost\|queries\|reportId`                    | per report + `UNATTRIBUTED`            | attributed, active and overhead credits, USD, share                                                                                                                   |
| `GET /costs/unit-economics?sort=costPerView\|reportId`               | per report                             | Snowflake-only and fully loaded cost per view; NULL for no costed views                                                                                               |
| `GET /costs/anomalies`                                               | four short sections, not paginated     | `perViewOutliers`, `zombies`, `awsViewsMismatch`, `quarantinedSnapshots`                                                                                              |
| `GET /costs/chargeback?view=point_in_time\|current&sort=cost\|owner` | per owner + `UNOWNED` + `UNATTRIBUTED` | point-in-time (admins and viewers; 403 for owners): each snapshot charged to that snapshot's owner. current (owners' default): whole history charged to today's owner |

Numbers that don't depend on ownership come from the results stored and reconciled at ingest
(`SQL_RESULTS`). The owner always comes from the live `REPORT_CURRENT_OWNER` view. The two row
sets that depend on ownership (current-owner chargeback, zombies) are read from the live views,
so overrides show up immediately. They are also the slowest calls, about 40–100 ms locally.

### Alerts and replay

The replay walks the 20 snapshots, one tick per 10 s, and wraps to snapshot 0. Rules (from
`config.ts`):

| rule              | fires on                   | severity           |
| ----------------- | -------------------------- | ------------------ |
| `LATENCY`         | load time > 15 s / > 30 s  | WARNING / CRITICAL |
| `REFRESH_FAILED`  | status FAILED or TIMED_OUT | CRITICAL           |
| `REFRESH_UNKNOWN` | status UNKNOWN             | INFO               |

Lifecycle: `OPEN → ACKNOWLEDGED → RESOLVED`.

- **Dedup:** one alert per (report, rule) while it is active.
- **Escalation:** severity only escalates; `value` and `message` hold the peak while active.
  Each escalation emits an update (`alert:updated` once sockets land).
- **Acknowledged alerts stay acknowledged.** If an ACKNOWLEDGED alert escalates (WARNING →
  CRITICAL), its severity, threshold, value and message change and an update is emitted, but
  its status stays ACKNOWLEDGED and `ackedBy` is kept. It does not reopen and needs no second
  ack. Clients should highlight the escalation rather than treat it as new.
- **Auto-resolve:** after 2 consecutive healthy ticks, acknowledged or not.
- **Cooldown:** the same key can reopen only 3 ticks after resolving. **Injected incidents
  bypass it**: an incident on a key that is cooling down opens a new alert immediately, so a demo
  always produces one. Real snapshot readings never bypass it.
- **Determinism:** ids are `<cycle>-<reportId>-<ruleId>-<openedTick>`. The state is rebuilt by
  replaying ticks 0..now, so a restart reproduces it.

- `GET /alerts?status=&severity=&page=&pageSize=` lists the current cycle's alerts: active
  first, then most severe, then most recently seen.
- `POST /alerts/:id/ack` (admin, or owner for their own reports) moves an alert OPEN →
  ACKNOWLEDGED and is idempotent. It returns 404 for an alert outside your scope and 409 once
  the alert has resolved.
- `GET /admin/replay` returns `{ tick, cycle, snapshotDate, paused, speed, tickMs }`.
- `POST /admin/replay` takes `{ "action": "pause" | "resume" }` or
  `{ "action": "speed", "value": 1 | 2 | 5 | 10 }`. Only the clock's time anchor moves, so the
  tick never jumps.
- `POST /admin/incidents` takes
  `{ "reportId": "RPT_203", "kind": "LATENCY_SPIKE" | "REFRESH_FAILED" }` and returns 201 with
  the resulting alert. It adds a synthetic reading at the current tick (load time 45 s, or
  status FAILED). The alert has `synthetic: true` when the incident opened it, and incidents
  bypass the cooldown. Repeating an identical incident (same report, kind and tick) is a no-op
  that returns the same alert. At most 200 distinct incidents are kept per replay cycle; beyond
  that the endpoint returns `429 RATE_LIMITED` until the replay wraps.

```json
{
  "id": "8958284-RPT_203-LATENCY-0",
  "reportId": "RPT_203",
  "reportName": "Analytics Dashboard 4",
  "ownerEmail": "user_3@company.com",
  "ruleId": "LATENCY",
  "severity": "CRITICAL",
  "status": "OPEN",
  "message": "Load time 45.8s > 30s",
  "value": 45.8,
  "threshold": 30,
  "openedTick": 0,
  "openedAt": "2026-10-10T18:26:40.000Z",
  "lastSeenTick": 8,
  "synthetic": false
}
```

### Owner overrides and audit log

`PATCH /reports/:id/owner` writes `OWNER_OVERRIDES` (one row per report; a second PATCH replaces
it) and an `AUDIT_LOG` row in **one transaction**. If either write fails, neither is kept.
`ownerEmail: null` orphans the report. The change takes effect immediately across the API:

- owner scoping, `currentOwner` and the overview's orphan count
- the current-owner chargeback and the zombie list
- the report's alerts

Point-in-time chargeback doesn't change, because it charges past snapshots to their owners at
the time. Reconciliation checks C1–C5 still hold, since overrides only move cost between owners.

**Nothing changes unaudited.** The override and its audit row share a transaction. Acks,
replay commands and incidents change in-memory state, so each is applied and then audited; if
the audit row can't be written, the change is undone (the ack or incident is withdrawn, or the
clock is restored to its previous timeline) and the request fails with 500. After an override
commits, the alert engine reloads the owner map. If that reload fails, the PATCH still returns
200, because the change did commit, and the next alert read retries the reload.

`GET /admin/audit-log?action=&page=&pageSize=` lists entries newest first:
`{ id, at, actorEmail, action, target, details }`. The actions are `OWNER_OVERRIDE`,
`ALERT_ACK`, `REPLAY_CONTROL` and `INCIDENT_INJECT`, and `details` holds before/after values.

## Known limitations

- **Alert acks and incidents are in memory.** A restart forgets them, and **acks reset when the
  replay wraps to snapshot 0**, because alert ids include the cycle. Replay pause and speed are
  in memory too; a restart resumes at speed 1 from wall time.
- **Overrides and the audit log live in `data/warehouse.duckdb`.** Re-running `npm run ingest`,
  or a Render redeploy (which rebuilds the warehouse), clears them.
- **Anyone can act as admin on the demo**, because the demo credentials are public. Anyone can
  reassign owners or pause the replay; a restart or redeploy resets the demo. The audit log
  grows by one row per admin action until then.
- **Logout doesn't revoke a JWT.** Tokens are stateless; a copied token works until it expires
  (8 h).
- **The login limiter is per process and in memory.** That is enough for one instance; several
  instances would need a shared store. Without a proxy in front, `X-Forwarded-For` is trusted
  from the client itself.

Smaller points from the security review, accepted as they are:

- Owners could estimate two portfolio-wide statistics (the median and spread of cost per view)
  from the z-scores on their own reports' anomaly rows.
- The Origin check compares host, not scheme; Render redirects HTTP to HTTPS anyway.
- `/health`, `/api/docs` and `/api/openapi.json` are mounted outside `ALL_ROUTES`, so the access
  matrix doesn't cover them. All three are public by design; nothing that needs auth may be
  added there.
- Swagger UI and the spec are public, and the login example uses the public demo password.
- An override's free-text `reason` and the admin who set it are visible to every role through
  the report detail.
