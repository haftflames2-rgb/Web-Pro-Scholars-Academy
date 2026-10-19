# Instructor/Admin Portal + Direct Admin Chat Fix

## Admin instructor portal view
- Active instructor accounts now have a **View portal** action in Admin Portal.
- The instructor portal opens in a protected, read-only admin preview mode.
- The selected instructor’s courses, lessons/media, students/enrollment status, and submissions are visible.
- Preview media/note/submission downloads use admin-authenticated routes scoped to that instructor.
- The administrator session is never converted into an instructor session.

## Instructor → Admin messaging
- Instructor accounts can now use SMARTTEP Chat.
- Instructor chat directory is restricted to administrators.
- Instructor direct-chat creation rejects non-admin recipients.
- Instructor Portal includes **Message Admin**, which opens the admin chat directly.
- Existing chat attachment, reply, read, and media routes accept authenticated instructors while preserving conversation membership checks.
- Administrator chat directory includes active instructors so admins can start/reply to instructor conversations.
