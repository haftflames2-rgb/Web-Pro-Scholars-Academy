# Exam Smart Security

This build adds exam-specific Smart Security to the existing SMARTTEP ACADEMY LMS.

## Student behavior
- When an exam starts, the exam page activates Smart Security.
- The browser reports when the exam document becomes hidden (for example, switching tabs, minimizing the browser, or leaving the exam page).
- A page-leave/page-close event is also reported where the browser permits it.
- The first confirmed exam-page departure locks the student's portal account immediately.
- The active exam attempt is marked `locked` and the security event is stored in MongoDB.
- The student sees a clear message that the account is locked pending administrator approval.

## Administrator behavior
Admin Portal now has **Exam Smart Security**.
- Shows time, student, student ID, exam, course, reason, and lock status.
- The administrator can **Approve & Unlock** the student.
- Unlocking clears the exam security portal lock and restores the exam attempt to `in_progress`.
- The security decision is logged.

## Browser limitation
A normal web application cannot inspect the entire device screen or see which other application is open. This feature therefore uses browser visibility/page lifecycle signals. It should not be described as full device surveillance.

## Database
A new `exam_security_events` MongoDB collection is created automatically. No new environment variables or database account are required.

Keep the existing `MONGODB_URI`, `MONGODB_DB`, `SESSION_SECRET`, and other deployment environment variables unchanged.
