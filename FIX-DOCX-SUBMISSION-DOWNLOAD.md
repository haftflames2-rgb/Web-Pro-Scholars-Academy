# DOCX Student Submission Download Fix

- Student submission validation now accepts `.doc` and `.docx`.
- Student submission uploads are stored as Cloudinary `raw` assets to preserve arbitrary assignment files.
- Admin submission records now expose a same-origin download endpoint instead of the direct Cloudinary URL.
- The download endpoint sets the MIME type from the original filename, including the official DOCX MIME type:
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `Content-Disposition: attachment` preserves the original filename and prevents mobile browsers from saving DOCX files as `.bin`.
- Existing submissions remain compatible because the download endpoint works from their stored URL and original filename.


## Additional mobile DOCX upload fix

The submission validator now accepts a DOCX file using either its `.docx` filename extension **or** the official DOCX MIME type (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`). This fixes Android/iOS/cloud-storage file pickers that send a DOCX without a normal extension in the multipart filename. The student file picker also advertises the official DOCX MIME type.
