# SMARTTEP ACADEMY V56 – Instructor Application Access + Manual Course Media Upload

Built on V55. Existing application features and database structure are retained.

## 1. Instructor application access
- The instructor application page now gives logged-out visitors clear Login and Create Student Account links.
- Both links carry a safe local return path so the visitor returns to `/instructor-apply.html` after successful login or registration.
- The application page explains that a SMARTTEP account is required before applying.
- The normal registration page now includes a “Become an Instructor” link.
- Creating a student account does not grant instructor privileges. Administrator approval remains required.

## 2. Admin course media upload
- Admin course management now uses local file pickers instead of requiring image/video URLs.
- Course cover: JPG, PNG or WEBP, maximum 5 MB.
- Course preview: MP4 or WEBM, maximum 50 MB.
- Uploads are stored in the existing Cloudinary account under course-covers and course-previews.
- When editing, leaving a picker empty keeps the existing media. Selecting a replacement uploads it and then removes the previous Cloudinary asset.
- Deleting a course also attempts to remove its uploaded cover and preview assets.
- Existing course image/video URLs remain compatible and continue displaying. Existing media is not forcibly migrated.

## 3. Environment and cost
- No new environment variables, accounts, packages, or paid services are introduced.
- Existing Cloudinary credentials/configuration are used.
- Cloudinary storage, video processing and bandwidth are subject to the user's existing plan limits. Large or heavily watched preview videos may require paid usage.

## 4. Validation performed
- `node --check` passed for server.js and the changed browser JavaScript files.
- ZIP integrity checked after packaging.
- Live MongoDB, Cloudinary upload, login/registration and browser end-to-end tests were not performed. Test with small sample files after deployment.
