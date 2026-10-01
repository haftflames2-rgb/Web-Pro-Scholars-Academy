# Instructor application visibility fix

## What was fixed
- Instructor submissions are now persisted to the user document before the secondary `instructor_applications` mirror.
- The admin application endpoint treats the user document as the source of truth, so a mirror/index problem cannot make a valid submission disappear.
- Legacy application records using ObjectId or string user IDs are still resolved and displayed.
- Approval/rejection keeps both the user record and dedicated application record synchronized.
- The admin page cache-busting version was incremented so the fixed JavaScript is loaded after deployment.
- The admin table now labels the two submitted requirements separately: what the applicant wants to teach, and their teaching plan/experience.
- The admin instructors endpoint now reads both the dedicated application collection and embedded user applications, so legacy/string-ID records remain visible.
- The admin dashboard now loads instructor applications even when an unrelated dashboard refresh fails.
- Instructor application state checks support legacy camelCase and snake_case embedded records.

## Validation
- `node --check server.js` passes.
- `node --check public/js/admin.js` passes.
- The embedded JavaScript in `public/instructor-apply.html` passes `node --check` after extraction.

- The instructor_applications userId index is now partial, so legacy records without userId cannot prevent server startup.
- Admin application actions use the resolved user_id, including applications served from the embedded user-document fallback.
- Admin JavaScript cache-busting was advanced again after the final audit patch.

## V7 MongoDB startup migration

The startup migration now detects legacy `instructor_applications` indexes keyed only by `userId` (including the old auto-named `userId_1` index), removes the conflicting legacy index automatically, and creates the intended named partial unique index `instructorApplicationUserId_unique`. This prevents MongoDB `IndexKeySpecsConflict` / code 86 on existing deployments and does not require manual Atlas index deletion.
