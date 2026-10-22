# SMARTTEP ACADEMY V42 — Scholarship Application Workflow

Built on the supplied V41 Moderator & Scholarship project.

## Changes
- Added Normal Admission / Scholarship Application choice to the registration page.
- Selecting Scholarship opens the scholarship application portal immediately.
- Added the five-section scholarship form requested by the academy, including a 200-word motivation limit, required declaration, typed signature, and auto-filled date.
- Added a public application-status checker that looks up status by email and returns only status/review note information.
- Added MongoDB-backed scholarship application storage and server-side validation/rate limiting.
- Added Admin review panel with applicant details, approve/reject actions, and optional review note.
- Approval does not automatically create an account. The applicant returns to registration, selects Scholarship, and creates an account with the same email.
- Scholarship access is granted only after Admin approval when the applicant registers; an application by itself does not unlock student access.
- Existing Admin registration payment-gate behaviour remains: when the gate is off, normal registrations continue to receive access according to the existing setting.
- Preserved the existing moderator and other project files from V41.

## Validation
- `node --check server.js` passed.
- `node --check public/js/auth.js` passed.
- `node --check public/js/scholarship-admin.js` passed.
- ZIP archive integrity checked after packaging.
- Not tested against the live Render service, MongoDB, Cloudinary, or browser end-to-end. Back up the current project before deploying.
