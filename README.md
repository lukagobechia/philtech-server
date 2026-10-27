# PhilTech API

Express 5 + TypeORM + PostgreSQL backend for the PhilTech Solutions website: careers (jobs and applications with CV upload), the contact form, call booking, and an admin REST API.

## Local development

```bash
cp .env.example .env              # then fill in secrets
docker compose up -d              # postgres, S3 gateway (SeaweedFS) on :9000, Mailpit on :8025
npm install
npm run storage:init              # create the private CV bucket
npm run migration:run
npm run seed:jobs                 # optional demo vacancies
ADMIN_PASSWORD='…' npm run admin:create -- you@philtechsol.com "Your Name" admin
npm run dev                       # http://localhost:4000
```

Outgoing email in dev is captured by Mailpit: http://localhost:8025.

## Scripts

| Script | Purpose |
|---|---|
| `dev` / `build` / `start` | Watch mode / compile to `dist` / run compiled server |
| `typecheck`, `test` | Types (src + tests) and integration tests (Testcontainers, needs Docker) |
| `migration:generate -- src/migrations/Name` | Diff entities against the DB and write a migration |
| `migration:run` / `migration:revert` | Apply / roll back (dev, via tsx) |
| `migration:run:prod` | Apply migrations from `dist` (release step) |
| `storage:init` | Create the CV bucket if missing |
| `admin:create` / `admin:create:prod` | Create or reset an admin user (password from `ADMIN_PASSWORD` or prompt) |

If Testcontainers fails with `docker-credential-desktop` errors, run tests with `DOCKER_AUTH_CONFIG='{"auths":{}}' npm test`.

## API overview (`/api/v1`)

**Public**
- `GET /jobs?lang=en|ka&q=&category=it|digital|other&location=tbilisi|batumi|remote&page=&limit=`
- `GET /jobs/filters`
- `GET /jobs/:slug?lang=`
- `POST /jobs/:slug/applications`: multipart; fields `firstName lastName city country(ISO-2) currentEmployer? currentPosition? email phone(E.164) consent=true locale` + `resume` file (PDF/DOC/DOCX ≤ 5 MB, checked by content)
- `POST /contact-messages`: `{ name, email, phone?, company?, service?: ui_ux|web|mobile, message, locale }`
- `GET /bookings/availability?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /bookings`: `{ name, email, phone?, startsAt (ISO from availability), timezone?, service?, notes?, locale }` → `409 SLOT_TAKEN` if taken

All public POSTs accept a honeypot field `website` (must be empty) and, when `TURNSTILE_SECRET` is set, require `turnstileToken`. Each form is rate limited per IP (10 / 10 min).

**Auth** (session cookie, httpOnly): `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`

**Admin** (`admin` role = everything; `recruiter` = jobs and applications)

**Audit log** (admins only)
- **What's recorded:** everything goes into `audit_logs`.
  - **Every API request** (except `/health/*`): route pattern, path, method, status, duration, request id, hashed IP and browser, the acting user, and the query and input. Admins' input is kept with passwords, tokens and secrets redacted; visitors' input is stored by field names only.
  - **Every change**, as `<entity>.<verb>`, in the same transaction as the change: status changes in every domain, vacancies, applications (including CV views and downloads), interviews, employees, overtime, team members, booking settings, sign-in/out and failed sign-ins, report exports and refused exports, and emails sent or failed.
  - **Background jobs** run as `system`: the vacancy and overtime schedulers, the email worker and retention. Runs are recorded when they did work or failed. Set `AUDIT_IDLE_JOB_RUNS=true` to also record idle ticks.
- **Who:** the user is a snapshot of id, email and role, so entries outlive the user. The table is append-only: a database trigger rejects UPDATE, and only retention deletes rows, after `AUDIT_RETENTION_DAYS` (default 730).
- `GET /admin/audit-logs`
  - filters: `q` (action, summary, path, email, record id, request id, user id), `actorId`, `actorType`, `category=request|event|job`, `outcome`, `action`, `actionPrefix` (e.g. `job.`), `entityType`, `entityId`, `method`, `status` (`404` or `4xx`), `route`, `requestId`, `from`/`to`
  - `sort=newest|oldest|slowest`
- `GET /admin/audit-logs/summary?groupBy=action|actorId|actorType|category|outcome|entityType|route|method|statusCode|day`: counts and failures per group; `actorId` groups include the email.
- `GET /admin/audit-logs/:id`: one entry plus the other entries from the same request.
- **Export:** `GET /admin/reports/audit?format=xlsx|csv&from=&to=` with the same filters.

**Employees and overtime**
- **Hiring:** setting an application to `hired` creates an employee in the same transaction. The employee gets the candidate's details, the vacancy title as position and the job code. It's created once per application; an existing employee with the same email is linked instead of duplicated.
- `/admin/employees`
  - list with `q`, `status`, `department`, `applicationId`, `sort=name|newest|startDate`
  - create (manually), get, `PATCH` (details, `schedule`, `status=active|inactive`)
  - `GET /board`: active employees with `presence`, which is `working` until the end of a block, `overtime` since a time, or `off` until the next shift. Computed in `COMPANY_TIMEZONE`.
  - `GET /:id/events`: the activity log
  - `POST /:id/overtime`: `{ reason, startedAt?, plannedEndAt? | endedAt? }`. Give `endedAt` to register overtime that already happened; only one entry can be running per employee.
- **Schedule:** weekly blocks `{ weekday: 1–7, start: "HH:MM", end: "HH:MM" }`, same-day and not overlapping; split shifts are allowed.
- `/admin/overtime`
  - `GET /` is the log: `employeeId`, `status`, `from`/`to`, with `totals.minutes`
  - `POST /:id/end`, `PATCH /:id` (corrections), `POST /:id/cancel`
  - Running overtime with a `plannedEndAt` ends automatically on the in-process scheduler (every 30 s). Deactivating an employee ends their running overtime.
- **Activity log:** every change is written to `employee_events` with the acting admin, or none for automatic actions, and the details before and after.
- **Reports:** `employees` and `overtime`.

**Dashboard and reports**
- `GET /admin/dashboard?from=&to=&granularity=day|week|month`: whole days in `COMPANY_TIMEZONE`. The default is the last 30 days, and the maximum is 731 days. Granularity is picked automatically when left out. The response contains:
  - totals with the same-length previous period
  - a timeline (applications and interviews; messages and call requests for admins)
  - the application pipeline, top vacancies, countries, interview and vacancy statuses
  - KPIs: open vacancies, interview rate, median days to first interview, interviews in the next 7 days
- `GET /admin/reports/:type?format=xlsx|csv&from=&to=&status=`
  - Types: `overview`, `applications`, `interviews`, `jobs`, `messages`, `bookings`. `messages` and `bookings` are admin-only.
  - Excel files have a styled, frozen and filterable header, real dates in company time, and one sheet per section for `overview`.
  - CSV is UTF-8 with a BOM, and cells that could run as formulas are neutralised.
  - Reports are capped at 50,000 rows, and each export is logged with the admin's id.

**Listing conventions** (admin lists)
- Pagination: `?page=&limit=` (limit ≤ 100); responses are `{ items, total, page, limit }`.
- Search: `?q=`. Applications match name, email, job code and title; messages also match the text; jobs match title (any language), code and slug.
- Filters: `?status=` accepts several comma-separated values. Other equality filters depend on the list:
  - applications: `jobId`, `jobCode`, `country`, `locale`
  - messages: `service`, `locale`
  - bookings: `service`
  - jobs: `category`, `location`, `employmentType`, `status=published|scheduled|draft|expired|archived`, `archived=false|true|all`
  - users: `role`, `isActive`
- Dates: `?from=&to=` are whole days (inclusive) in `COMPANY_TIMEZONE`. They filter on when an item was received, or on the call time for bookings.
- Sorting: `?sort=`.
  - all inbox lists: `newest|oldest`
  - applications also: `name`
  - bookings also: `soonest|latest`, by call time
  - jobs: `newest|oldest|title|deadline|publishAt`
- Grouping: `GET <list>/summary?groupBy=<column>&<same filters>` returns `{ groupBy, total, groups: [{ key, count }] }`.
  - The summary applies every filter except the one on the grouped column, so each group's count is shown.
  - Inbox lists group by `status`. Applications can also group by `jobCode`, `country` or `locale`; messages by `service` or `locale`; bookings by `service`.
  - Jobs (`/admin/jobs/summary`) group by `status`, `category`, `location` or `employmentType`.
- Calendar: `?kind=booking,interview&status=…` narrows the feed.
- Public `GET /jobs/filters` also returns `counts` of open jobs per category and location.
- `/admin/jobs`: list (`?archived=false|true|all`, default active), create, get, `PATCH`, `DELETE`, `POST /:id/publish|unpublish|archive|unarchive`
  - Scheduling: send `publishAt` (ISO time) on create or on `PATCH` of an unpublished job. A scheduler in the API process checks every 30 s: it publishes jobs whose `publishAt` has come, and unpublishes published jobs once their `applicationDeadline` day is over in `COMPANY_TIMEZONE` (default Asia/Tbilisi). Publishing by hand or unpublishing clears the schedule; publishing after the deadline is rejected with `DEADLINE_PASSED`.
  - `POST /admin/jobs/archive-unpublished`: archives every unpublished, unscheduled job and returns `{ archived }`.
  - Every job has a permanent `code` (e.g. `IT-2026-007`: domain prefix IT/DIG/GEN from the category, year, and a number from the `job_code_seq` sequence), or a custom one given on create. It can't be changed and is never reused.
  - Applications store `jobCode` and `jobTitle` when submitted. Deleting a job keeps its applications (`jobId` becomes null). Archiving takes the job off the site and closes it to applications; restoring brings it back as a draft.
  - `GET /admin/jobs/codes`: every code in use, with state `active|archived|deleted` and its application count. Applications can be filtered with `?jobCode=`, and `q` searches codes too.
- `/admin/applications`: list (`?status=&jobId=&q=`), get, `PATCH {status}`, `DELETE`, `GET /:id/resume` → 5-minute signed download URL
- `/admin/contact-messages`, `/admin/bookings`: list (`?status=&q=`), get, `PATCH {status}`
- `/admin/users`: list, create, `PATCH` (role/active/password; revokes sessions)

Errors always look like `{ "error": { "code", "message", "details?" } }`. Every response carries `X-Request-Id`.

## Health

- `GET /health/live`: process is up
- `GET /health/ready`: database and object storage reachable (503 otherwise)

## Production notes

- Build the image with `docker build .`. It runs `node dist/server.js` as a non-root user with a `HEALTHCHECK`.
- Run `npm run migration:run:prod` as a release step before starting new instances. Migrations do not run on boot.
- Required: real S3/R2 credentials (leave `S3_ENDPOINT` empty for AWS), SMTP credentials, a random `IP_HASH_SECRET`, `DATA_ENCRYPTION_KEY` and `DATA_INDEX_KEY` (back these up: losing them loses the personal data they encrypt), `CORS_ORIGINS` = the site origin(s), and `TRUST_PROXY` = number of proxies in front (needed for correct per-IP rate limiting).
- Client IPs and the Next.js proxy: browsers reach the API through the site's `/api/*` rewrite. Next.js passes `X-Forwarded-For` through unchanged and does not add its own. So put the site behind an edge proxy/LB that **appends** the client IP (e.g. nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, or a platform like Vercel), keep the API reachable only from the Next.js server, and set `TRUST_PROXY=1`. Without that, rate limiting either sees every visitor as the same IP or trusts a spoofable header.
- Rate limits use in-memory counters, which is fine for one instance. With several instances, switch to a shared store such as `rate-limit-redis`.
- Emails go through a database outbox (retries with backoff, safe with several instances). A daily retention job deletes applications and CVs older than `RETENTION_MONTHS`, plus expired sessions and sent emails older than 30 days.
