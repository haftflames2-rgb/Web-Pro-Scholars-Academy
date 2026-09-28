# Profile Picture Fix

The profile picture display was fixed by rebuilding Cloudinary delivery URLs from the stored `publicId` instead of trusting a previously stored URL.

This is important for existing student accounts whose `profilePicture.url` is stale or malformed.

## Deploy
Replace the project on Render with this version and redeploy. Keep the same MongoDB and Cloudinary environment variables.

Required Cloudinary variables:
- CLOUDINARY_CLOUD_NAME
- CLOUDINARY_API_KEY
- CLOUDINARY_API_SECRET

No database reset is required.

## 2026-09-28 mobile display fix

The profile image display was hardened for mobile browsers. Legacy records with a bare Cloudinary `publicId` are now resolved against the `wps-academy/profile-pictures` folder, while stored URLs remain a compatibility fallback. The Student Portal now installs the image error fallback immediately and checks already-failed images, so a broken Cloudinary image cannot remain as the visible `Profile Picture` alt text.

Only profile-picture URL resolution and Student Portal profile-image rendering were changed.
