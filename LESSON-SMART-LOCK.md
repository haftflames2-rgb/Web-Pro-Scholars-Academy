# SMARTTEP ACADEMY — Lesson Smart Lock

## V15

Lesson notes, video and audio are now protected by a server-side Smart Lock layer.

### Access rules
- A student can always access a lesson they previously accessed or completed.
- A first lesson without a release date is available immediately.
- Later/new lessons are locked for students until the Admin/Instructor release date is reached, unless an existing access record or an Admin override applies.
- The release date is stored on the lesson as `unlockAt`.
- Protected note, video and audio endpoints enforce the same rule server-side, so hiding a button in the browser is not the security boundary.
- Direct Cloudinary URLs are no longer returned by student learning/content APIs.

### Admin authority
- Admin can set/change the lesson release date.
- Admin can enable a global Smart Security override for a lesson.
- Admin can grant or revoke permanent access for an individual student/lesson.
- Admin override and student-specific grants are stored separately from normal lesson progress.

### Instructor authority
- An instructor can set/change the release date for lessons in courses they own.
- Instructors cannot enable the Admin-only global override or grant themselves access to another instructor's course.

### Existing data
Existing `lesson_progress` records remain valid. A completed lesson is treated as previously accessed. New `accessedAt` timestamps are added when a student legitimately opens a protected lesson resource or lesson context.

### No new environment variables
The feature uses the existing MongoDB connection and creates the `lesson_access_overrides` collection automatically. No new Render, MongoDB, Cloudinary, or API credentials are required.
