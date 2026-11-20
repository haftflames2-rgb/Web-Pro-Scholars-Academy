# SMARTTEP ACADEMY V41 — Moderator Management and Scholarship Gate

## Added
- Admin-controlled registration payment gate stored in the existing MongoDB `app_settings` collection.
- When the payment gate is OFF, newly registered students are approved and receive a persistent scholarship grant. Turning the gate back ON does not revoke previously granted scholarship access.
- Admin can create multiple dedicated moderator accounts, assign course IDs and configure lesson upload, attendance, assignment review, grading, and student-progress permissions.
- Admin can edit moderator permissions/course assignments and suspend/reactivate moderators.
- Public moderator application form; applications remain pending until an admin approves or rejects them. Approval creates a moderator account with admin-assigned permissions and a temporary password.
- Moderator portal supports assigned-course lesson note/audio/video uploads, attendance marking, assignment submission review/download, grading/feedback, and progress viewing where enabled.
- Moderator actions are recorded in `moderator_audit_logs`.
- Moderator temporary passwords must be changed at first login.
- Added server-side role, permission, and assigned-course checks; student-only endpoints reject moderator role access.

## Data and deployment notes
- Uses the existing MongoDB connection and existing Cloudinary upload configuration; no new environment variables or paid services are introduced.
- Existing users, courses, lessons, attendance, assignments, submissions, payment data, and current scholarship access are not migrated or deleted.
- New MongoDB collections created on demand: `moderator_applications`, `moderator_audit_logs`.
- Registration payment gate defaults to ON if no setting exists, so existing registration behaviour is preserved until Admin explicitly turns it OFF.

## Validation
- `node --check server.js` and syntax checks for the new moderator JavaScript files passed.
- No live Render, MongoDB, or Cloudinary deployment test was performed from this package build.
