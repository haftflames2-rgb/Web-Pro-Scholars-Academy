# SMARTTEP ACADEMY V16 — Smart Student Inactivity & Dormant IP Protection

## Automatic student suspension
Smart Security now monitors genuine student activity using `lastActivityAt`.

- After **168 hours (7 days)** without activity, Smart automatically suspends/portal-locks the student account.
- The existing `portalLocked` enforcement is used, so the student cannot continue using the portal until an administrator restores access.
- The event is recorded in `security_events` with the Smart Security source and last known IP.
- Existing accounts without `lastActivityAt` are initialized when this version starts; existing timestamps are preserved.

## Dormant student IP protection
After **336 hours (14 days)** since a student's last genuine activity, Smart can block that student's **last known public IP address**.

- The IP block is persistent until an administrator overrides/unblocks it.
- It is stored separately from normal temporary device blocks as `blockType: dormant-student-ip`.
- Admin API requests bypass Smart device/IP enforcement so administrators retain final authority.
- The Admin Smart Security panel lists dormant IP blocks and provides an **Unblock IP** control.

### Shared-IP warning
Public IP addresses can be shared by multiple people/devices. Blocking a public IP can therefore affect other users behind the same NAT, school, office, household, or hotspot. This is an intentional consequence of the requested IP-level policy. Admin can immediately unblock the IP or disable dormant-IP automation.

## Admin authority / override
Administrators can:

- Disable automatic 168-hour student suspension.
- Disable automatic 336-hour dormant student IP blocking.
- Use **Override Smart** on a Smart-suspended student to restore the account.
- Unblock a dormant IP from the Smart Security panel.
- Continue using the existing manual student Lock/Unlock control.

Every administrator override is logged as a Smart Security `admin-override` event.

## No new environment variables
The feature uses the existing MongoDB and security collections. No new Render, MongoDB, Cloudinary, or API credentials are required.
