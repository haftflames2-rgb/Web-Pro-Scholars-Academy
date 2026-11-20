# SMARTTEP ACADEMY V23 — Admin Login Popup Announcements

V23 adds a server-side announcement system for authenticated students and instructors.

## Admin controls
- Audience: Students + Instructors, Students only, or Instructors only
- Title and rich-length plain text message
- Optional JPG/PNG/WEBP picture (maximum 8 MB)
- Start date/time and end date/time
- Priority
- Display mode: every login until expiry, or once per user
- Activate/pause and delete existing announcements

## User experience
- Targeted users see the announcement after their portal loads following login.
- The popup has a clear close button and acknowledgement action.
- Only the server determines which role receives an announcement.
- Once-per-user announcements are tracked in MongoDB.
- Every-login announcements continue to appear on subsequent logins while active.
- Expired or paused announcements stop appearing automatically.

## Security
- Admin creation/edit/delete routes require the existing authenticated Admin controls and Admin 2FA policy.
- User delivery requires an authenticated session and is limited to student/instructor roles.
- Announcement pictures use the existing secure upload screening and a dedicated 8 MB upload limit.
- User acknowledgements are scoped to the authenticated user ID; browser-side role filtering is not trusted.

No new environment variables, Redis service, push-notification provider, or paid subscription is required.
