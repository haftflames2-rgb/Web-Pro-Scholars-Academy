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
