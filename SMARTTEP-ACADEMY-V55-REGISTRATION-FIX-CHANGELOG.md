# SMARTTEP ACADEMY V55 — Normal Registration Fix

## Critical bug fixed
Normal student registration was inserting `studentIdNumber: null` while MongoDB enforced a unique sparse index on `studentIdNumber`. MongoDB sparse indexes include explicit null values, so after one such record existed, later registrations could fail with duplicate-key error code 11000. The registration handler incorrectly translated every duplicate-key error into “Email already registered.”

## Changes
- Migrates the `studentIdNumber_1` index at server startup from the old unique sparse index to a unique partial index that applies only when `studentIdNumber` is a string.
- Stops explicitly writing `studentIdNumber: null` for new student registrations.
- Reports “email already registered” only when MongoDB identifies the email field as the duplicate; other duplicate-key conflicts now receive a separate, accurate message.
- Preserves existing users and existing non-empty student ID values; no user records are deleted or rewritten by this index migration.

## Deployment notes
- No new environment variables, accounts, packages, or paid services are required.
- Deploy the complete V55 project, not just `server.js`.
- On startup, the server drops and recreates only the old `studentIdNumber_1` index if it is the legacy sparse version. The replacement index continues enforcing uniqueness for actual string student ID numbers while allowing multiple users without an assigned ID.
- Existing MongoDB data is retained. Take a normal database backup before deploying any production update.

## Validation performed
- `node --check` on server.js and all JavaScript files under public/.
- ZIP archive integrity test.
- Static source inspection of the registration route and index migration.

Not performed: live MongoDB migration, real user registration against the production database, or live Render deployment. Those require access to the deployed environment and its database.
