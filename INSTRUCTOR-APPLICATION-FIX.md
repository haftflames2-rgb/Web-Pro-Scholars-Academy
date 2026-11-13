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

## Deployment follow-up: MongoDB IndexKeySpecsConflict fix

A deployment using the previous V6 package can fail during startup when MongoDB already contains the legacy auto-generated `userId_1` unique index. MongoDB does not permit `createIndex()` to change that existing index's options in place, so requesting the new partial index can return error code 86 (`IndexKeySpecsConflict`).

The server now checks the existing `instructor_applications` indexes during startup, removes conflicting unique `userId` indexes, and creates an explicitly named partial unique index (`instructor_userId_unique_present`). Non-unique `userId` indexes are preserved. This makes the migration safe for an existing Atlas collection instead of requiring a manual database operation before deployment.


## V8 critical-path hardening

- Removed instructor-application index creation from server startup entirely; the legacy mirror collection can no longer prevent deployment with `IndexKeySpecsConflict`.
- The embedded `users.instructorApplication` record is the authoritative submission source.
- Submission response no longer waits for the legacy mirror write. The mirror is best-effort with a 1.5-second MongoDB limit.
- Admin application retrieval reads embedded user applications first; the legacy mirror is only a bounded fallback.
- Instructor status checks read the embedded user application first.
- Admin approve/reject keeps the user account update authoritative and treats the mirror as best-effort.
- The applicant form now has a 20-second request timeout, explicit network/server errors, and keeps the success message and submitted fields visible instead of clearing/hiding them.
- A pending response after a lost network connection is treated as an already-submitted application rather than asking the user to submit again.
- `instructor-apply.html` is served with no-cache headers to prevent an older cached form from being used after deployment.
