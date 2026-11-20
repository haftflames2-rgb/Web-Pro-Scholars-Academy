# SMARTTEP ACADEMY V28 — SMART PUSH NOTIFICATIONS

V28 adds real Web Push notifications for students and instructors while preserving the existing SMARTTEP ACADEMY system.

## What is included

- Student/instructor device notification registration.
- Browser/phone permission button; no notification permission is requested silently.
- Web Push using VAPID and the `web-push` package.
- VAPID keys are generated once on first startup and the private key is encrypted with `SESSION_SECRET` before being stored in MongoDB. This avoids requiring a new Render secret just to start the feature.
- Admin can send a push to all students/instructors, students only, or instructors only.
- Existing Admin login-popup announcements can optionally also be sent as a phone push.
- Instructor can send a push to students enrolled in one of the instructor's own courses.
- New lesson upload by Admin or Instructor automatically sends a push to enrolled students.
- Lesson media update (note/video/audio) automatically sends an update notification.
- Admin/Instructor lesson release changes can send a notification when access becomes immediately available.
- Expired/unusable push subscriptions are removed automatically when the push provider returns 404/410.
- Push click opens the requested SMARTTEP page.
- Unsupported browsers continue to use normal in-site announcements; push is an additional channel.

## What the owner does after deployment

1. Deploy this ZIP to the existing Render service.
2. Keep the existing MongoDB, Cloudinary and environment variables.
3. Do not delete/recreate the AdSense site.
4. Log in as a student or instructor on a supported phone/browser.
5. Press **Enable phone notifications** and choose **Allow** when the browser asks.
6. Test by uploading a lesson or sending a notification from Admin/Instructor.

No manual VAPID-key generation is required. The application creates and stores its VAPID key pair automatically in MongoDB, encrypted with the existing `SESSION_SECRET`.

## Important browser behavior

The user must grant notification permission. Browser/OS notification settings can still suppress notifications. Opera Mini and other browsers with limited Web Push support may not provide true background push; the normal SMARTTEP in-site notification system remains available.

## Security

- Push registration requires an authenticated student/instructor session.
- Admin push sending requires Admin authentication and existing Admin Smart Security/2FA controls.
- Instructor push sending is restricted to the instructor's own course and enrolled students.
- Push payloads contain short notification text and navigation URLs, not passwords or sensitive security details.
