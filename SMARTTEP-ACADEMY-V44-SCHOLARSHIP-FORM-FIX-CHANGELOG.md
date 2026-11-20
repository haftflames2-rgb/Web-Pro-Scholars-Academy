# SMARTTEP ACADEMY V44 — Scholarship Form Fix

- Fixed the scholarship form refreshing instead of submitting: its inline JavaScript was blocked by the existing Content Security Policy (`script-src 'self'`). The form logic is now loaded from a same-origin external JavaScript file.
- Successful application submissions continue to save through `/api/scholarship-applications` and redirect to the ₦1,000 scholarship payment portal.
- Removed Mobile App Development (Android/iOS), Data Analysis & Software Engineering, and Other from the scholarship program choices.
- Removed Physical / In-Person from preferred study mode; Virtual / Online remains.
- Updated server-side validation to accept only the remaining program and study mode.
- Preserved the existing scholarship payment portal and admin review workflow.
