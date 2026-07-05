import { SetMetadata } from "@nestjs/common";

export const LICENSE_EXEMPT_KEY = "isLicenseExempt";

/**
 * Marks a route (or controller) as exempt from the LicenseGuard's read-only
 * enforcement. Reserved for the escape hatches a locked-out tenant still
 * needs: the licensing endpoints themselves (see status / redeem a grant
 * code), the upload-session cookie issuer (viewing files read-only), and the
 * platform-admin area (an admin must never be blocked by their own company's
 * license state).
 */
export const LicenseExempt = () => SetMetadata(LICENSE_EXEMPT_KEY, true);
