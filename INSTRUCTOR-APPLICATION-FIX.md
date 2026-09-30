# Instructor application visibility fix

## What was fixed
- Instructor submissions are now persisted to the user document before the secondary `instructor_applications` mirror.
- The admin application endpoint treats the user document as the source of truth, so a mirror/index problem cannot make a valid submission disappear.
- Legacy application records using ObjectId or string user IDs are still resolved and displayed.
- Approval/rejection keeps both the user record and dedicated application record synchronized.
- The admin page cache-busting version was incremented so the fixed JavaScript is loaded after deployment.
- The admin table now labels the two submitted requirements separately: what the applicant wants to teach, and their teaching plan/experience.

## Validation
- `node --check server.js` passes.
- `node --check public/js/admin.js` passes.
