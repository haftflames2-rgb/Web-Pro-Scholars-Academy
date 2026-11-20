SMARTTEP ACADEMY V50 — Complete Student Inspection Portal

Based on V49. Adds an admin-only, read-only inspection endpoint and sections on the existing Open User Portal page for attendance and percentages, exam attempts/answers/scores, exam security incidents, certificate requests and verification links, payment history and stored proof documents, student notifications, support tickets, full assignment submissions and uploaded work, and portal visit history.

No new environment variables or paid services are required. Uses the existing MongoDB and Cloudinary configuration. Existing V49 features are retained.

Checks performed: Node syntax checks for server.js and public/js/admin-student.js; ZIP integrity check. Not live-tested against the production Render service or a real student account.

Notes: Data is read-only in this view. Items not recorded by the application, and historic records deleted before this version, cannot be reconstructed. Notification display depends on notification documents using the existing userId field. Attendance percentage is calculated against scheduled weekdays up to the current Lagos date.
