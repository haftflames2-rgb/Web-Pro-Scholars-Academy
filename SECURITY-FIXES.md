# WPS Academy — Security/Correctness Fixes

This build includes the production hardening applied on 2026-09-14.

## Fixed

1. Password hashes are excluded from the student dashboard response.
2. Registration persists validated selected course IDs.
3. Login, registration, payments and AI generation endpoints have rate limits.
4. Production startup requires a strong `SESSION_SECRET` and `ADMIN_PASSWORD`.
5. New payment proofs use authenticated/private Cloudinary delivery and short-lived signed admin URLs.
6. Upload extensions are restricted by upload purpose.
7. Student email is not included in AI model context.
8. AI quiz answer keys are stored server-side; submitted scores are calculated from the server copy.

## Render

Set all variables in `.env.example` in the Render dashboard. In particular, set real values for:

- `MONGODB_URI`
- `MONGODB_DB`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `OPENAI_API_KEY` (if AI Tutor is enabled)

Build command: `npm install`

Start command: `npm start`

Node version: `24.14.1`

## v2 Course Management
- Admins can create, edit, lock/unlock, and delete courses from the Admin Portal.
- Course deletion cleans related lessons, assignments, submissions, lesson progress, and student enrollment references.
- Default courses are seeded only once so an admin-deleted course is not recreated on every restart.
- Course records support `price` and optional `thumbnail` URL fields.

## Smart Security hardening — 2026-09-28

This build strengthens the existing Smart Security layer without requiring a new paid security service or new Render environment variable.

- Temporary Smart IP blocks are persisted in MongoDB, so Render restarts/sleep do not erase active blocks.
- Repeated failed logins from one IP are logged and can trigger a reversible 30-minute automatic IP block after 8 failures in 15 minutes.
- High-risk Smart request probes can be automatically blocked when Smart is in auto mode.
- Critical detections remain protected by `requireApprovalForCritical`; Smart does not perform destructive/irreversible actions from an AI guess.
- Successful login regenerates the session to reduce session-fixation risk.
- Logout clears the session cookie after destroying the server-side session.
- Security event retention is automatically cleaned according to the Smart Security retention setting.
- HTTPS security headers include HSTS in production; `X-Powered-By` is disabled.
- Smart Security configuration is upgraded once to safe automatic-response defaults: high-risk blocking enabled, critical blocking disabled, and critical approval required. Admins can change the mode in the Admin Portal.

No new npm package and no new Render environment variable are required.
