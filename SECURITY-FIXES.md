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
