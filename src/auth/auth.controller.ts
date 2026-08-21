import { Body, Controller, Get, Ip, Logger, Post, Res, UnauthorizedException, BadRequestException, ConflictException, NotFoundException, GoneException, Headers } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply } from "fastify";
import { DatabaseService } from "../database/database.service";
import { LicenseExempt } from "../licensing/license-exempt.decorator";
import { LicensingService } from "../licensing/licensing.service";
import { TERMS_VERSION } from "../licensing/terms";
import { CompanyId } from "../common/company-id.decorator";
import { UserId } from "../common/user-id.decorator";
import { UserRole } from "../common/user-role.decorator";
import { Public } from "./public.decorator";
import { buildUploadCookieHeader, signUploadCookie } from "./upload-cookie";
import { verifyToken } from "./verify-token";
// Redemption has to fold a typed code onto the format staff.service mints.
// Pure module (no DI) so this is a plain import, not a module dependency.
import { canonicalizeInviteToken } from "../staff/invite-token";
import { z } from "zod";

// Structural shape only — required-field, format, and conflict checks are run
// explicitly in setup() below so each returns its exact status code + copy.
const ownerSetupSchema = z.object({
  role: z.literal("owner"),
  company_name: z.string().max(120).optional(),
  display_name: z.string().max(80).optional(),
  city: z.string().max(100).optional(),
  address_line_1: z.string().max(200).optional(),
  address_line_2: z.string().max(200).optional(),
  postal_code: z.string().max(20).optional(),
  website: z.string().max(200).optional(),
  industry: z.string().max(100).optional(),
  company_size: z.string().max(20).optional(),
  tax_id: z.string().max(50).optional(),
  currency_default: z.string().max(10).optional(),
  timezone: z.string().max(60).optional(),
  // Terms of Use click-wrap (required true — enforced in setup(), not here,
  // so the error carries exact copy) + the plan picked on the signup plan
  // step. The enum mirrors the seeded self-serve catalogue; enterprise is
  // contact-only and trial is the default, so nothing else is accepted.
  terms_accepted: z.boolean().optional(),
  plan_code: z.enum(["trial", "starter", "growth"]).optional(),
  // Optional marketing consent from the signup card (name + logo only).
  // Absent or false both mean "no" — unlike terms_accepted this is never
  // required, and nothing in signup fails when it's missing.
  showcase_opt_in: z.boolean().optional()
});

const staffSetupSchema = z.object({
  role: z.literal("staff"),
  invite_token: z.string().max(120).optional(),
  display_name: z.string().max(80).optional(),
  terms_accepted: z.boolean().optional()
});

const setupSchema = z.discriminatedUnion("role", [ownerSetupSchema, staffSetupSchema]);

// The engine's canonical IANA zone list (Node 18+). Used to accept a timezone
// case-insensitively — mirrors the client's canonicalTimezone().
const IANA_TIMEZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof fn === "function") return fn("timeZone");
  } catch {
    /* fall through */
  }
  return [];
})();

// Resolve a user-entered timezone to its canonical IANA form, tolerating case
// and whitespace. Returns null for a missing/blank value OR one that isn't a
// real zone (the caller distinguishes the two: blank input is allowed, a
// non-empty value that fails to normalize is a 400).
function normalizeTimezone(input: string | undefined | null): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  try {
    // resolvedOptions().timeZone validates AND canonicalizes: modern engines
    // accept loose casing and return the proper zone here, throwing only for a
    // non-zone. (Mirrors the client's canonicalTimezone.)
    return new Intl.DateTimeFormat(undefined, { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    // Stricter engines throw on bad casing — fall back to a case-insensitive
    // match against the known zone list.
    const lower = raw.toLowerCase();
    return IANA_TIMEZONES.find((z) => z.toLowerCase() === lower) ?? null;
  }
}

@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  // Supabase project URL + a key for the verify-only client verifyToken uses to
  // reach the JWKS. Prefer the anon key (least privilege); fall back to the
  // service-role key, which is always configured — so a missing anon key never
  // blocks startup. URL is required (getOrThrow).
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly licensing: LicensingService
  ) {
    this.supabaseUrl = config.getOrThrow<string>("SUPABASE_URL");
    this.supabaseKey =
      config.get<string>("SUPABASE_ANON_KEY") ??
      config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY");
  }

  // Durable record that this person accepted the CURRENT Terms of Use: an
  // append-only audit row (the legal artifact) + a fast current-version stamp
  // on the users row (absent pre-setup — the audit row still lands). Both
  // best-effort with warnings: the terms tables arrive in the 2026-07-17
  // migration and signup/acceptance must never 500 on a pre-migration DB —
  // the terms_accepted REQUIREMENT is enforced in code either way.
  private async recordTermsAcceptance(
    userId: string,
    email: string | null,
    ip: string | null,
    userAgent: string | null
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO terms_acceptances (user_id, email, terms_version, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, email, TERMS_VERSION, ip, userAgent?.slice(0, 400) ?? null]
      );
    } catch (err) {
      this.logger.warn(
        `Could not write terms_acceptances for ${userId} (migration pending?): ${err instanceof Error ? err.message : err}`
      );
    }
    try {
      await this.db.query(
        "UPDATE users SET tos_accepted_at = now(), tos_version = $2 WHERE id = $1",
        [userId, TERMS_VERSION]
      );
    } catch (err) {
      this.logger.warn(
        `Could not stamp users.tos_version for ${userId} (migration pending?): ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Existing members accepting a new (or first) terms version — the client's
  // re-accept interstitial posts here. @LicenseExempt: acceptance must work
  // even when the workspace is read-only or on hold.
  @LicenseExempt()
  @Post("accept-terms")
  async acceptTerms(
    @UserId() userId: string,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined
  ) {
    let email: string | null = null;
    try {
      const { rows } = await this.db.query<{ email: string }>(
        "SELECT email FROM users WHERE id = $1",
        [userId]
      );
      email = rows[0]?.email ?? null;
    } catch {
      // best-effort context only
    }
    await this.recordTermsAcceptance(userId, email, ip ?? null, userAgent ?? null);
    return {
      ok: true,
      terms_version: TERMS_VERSION,
      tos_version: TERMS_VERSION,
      tos_accepted_at: new Date().toISOString()
    };
  }

  // Issue (or refresh) the HttpOnly upload-session cookie. Runs through the
  // global SupabaseAuthGuard (Bearer), so req.companyId is already populated.
  // The cookie authorizes same-origin GETs of guarded uploads that cannot carry
  // a Bearer header (<img>/<iframe>/<a download>/STL viewer fetch). The client
  // calls this on every session change (login + token refresh).
  // @LicenseExempt: a read-only (license-lapsed) workspace must still be able
  // to VIEW its uploads, and this POST is what makes those GETs work.
  @LicenseExempt()
  @Post("session")
  async issueUploadSession(
    @CompanyId() companyId: string,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const token = signUploadCookie(
      this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY"),
      companyId
    );
    const secure = process.env.NODE_ENV === "production";
    reply.header("Set-Cookie", buildUploadCookieHeader(token, secure));
    return { ok: true };
  }

  @Public()
  @Get("me")
  async getMe(@Headers("authorization") authHeader: string) {
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing token.");
    }
    // Verify the token directly. Runs @Public() because the users row may not
    // exist yet (pre-setup), so the global guard's profile lookup would 401.
    const token = authHeader.slice(7);
    const { userId } = await verifyToken(token, this.supabaseUrl, this.supabaseKey);
    return this.composeProfile(userId);
  }

  /**
   * The whole profile: identity, permissions, and every company setting group.
   *
   * Every settings endpoint returns THIS, not its own SELECT. They used to each
   * run a partial query naming only the columns that endpoint touched, and the
   * client does `setProfile(response)` — a wholesale replace. So saving the
   * electricity price silently dropped branding, consent flags, terms state and
   * the licence from the in-memory profile until the next reload. One composer
   * means a settings save can never shrink the profile again.
   *
   * Each column group stays in its own try/catch on purpose: a column missing
   * because a migration hasn't run must not 500 /auth/me and lock everyone out.
   * An absent group simply doesn't appear, and the client treats it as unset.
   */
  private async composeProfile(userId: string) {
    const { rows } = await this.db.query<{ user_id: string; company_id: string; company_name: string; operation_mode: string; role: string; permissions: Record<string, boolean>; display_name: string | null; email: string }>(
      `SELECT u.id AS user_id, u.company_id, c.name AS company_name, c.operation_mode, u.role, u.permissions, u.display_name, u.email
       FROM users u JOIN companies c ON c.company_id = u.company_id
       WHERE u.id = $1`,
      [userId]
    );
    if (!rows.length) return null;
    // Best-effort pricing — never let a not-yet-migrated pricing column block
    // login. If the columns are missing the query throws and we just omit them.
    const profile: Record<string, unknown> = { ...rows[0] };
    try {
      const pricing = await this.db.query<{ electricity_price_per_kwh: string | null; shop_rate: string | null; store_full_slicer_files: boolean | null }>(
        `SELECT c.electricity_price_per_kwh, c.shop_rate, c.store_full_slicer_files
         FROM companies c JOIN users u ON u.company_id = c.company_id
         WHERE u.id = $1`,
        [userId]
      );
      if (pricing.rows[0]) Object.assign(profile, pricing.rows[0]);
    } catch {
      // pricing columns not migrated yet — profile still returns without them
    }
    try {
      const branding = await this.db.query<{ logo_url: string | null; slogan: string | null; about_text: string | null }>(
        `SELECT c.logo_url, c.slogan, c.about_text
         FROM companies c JOIN users u ON u.company_id = c.company_id
         WHERE u.id = $1`,
        [userId]
      );
      if (branding.rows[0]) Object.assign(profile, branding.rows[0]);
    } catch {
      // branding columns not migrated yet — profile still returns without them
    }
    // Best-effort consent/activation flags (2026-07-25 migration). Kept in
    // their own try/catch rather than folded into the main SELECT above: a
    // missing column there would 500 /auth/me and lock everyone out until the
    // migration runs. Absent columns simply read as "off", which is also the
    // safe default for both — no marketing use, no AI.
    try {
      const flags = await this.db.query<{ showcase_opt_in: boolean; showcase_opt_in_at: string | null; ai_analyst_enabled: boolean }>(
        `SELECT c.showcase_opt_in, c.showcase_opt_in_at, c.ai_analyst_enabled
         FROM companies c JOIN users u ON u.company_id = c.company_id
         WHERE u.id = $1`,
        [userId]
      );
      if (flags.rows[0]) Object.assign(profile, flags.rows[0]);
    } catch {
      // flags not migrated yet — client treats undefined as off
    }
    // Best-effort automated-messages switch (2026-08-13 migration). Its own
    // group, not folded into the flags SELECT above, so a pre-migration DB
    // doesn't take the showcase/AI flags down with it. Absent reads as
    // undefined, which the client treats as ON — matching the column default,
    // so an un-migrated deployment keeps sending exactly as it does today.
    try {
      const messaging = await this.db.query<{ automated_messages_enabled: boolean }>(
        `SELECT c.automated_messages_enabled
         FROM companies c JOIN users u ON u.company_id = c.company_id
         WHERE u.id = $1`,
        [userId]
      );
      if (messaging.rows[0]) Object.assign(profile, messaging.rows[0]);
    } catch {
      // column not migrated yet — client treats undefined as on
    }
    // Best-effort asset-form display default (2026-08-16 migration). Its own
    // group for the same reason as the one above: this is a cosmetic preference
    // and must never be the thing that takes a real flag — or a login — down.
    // Absent reads as undefined, which the client treats as "show everything",
    // matching the column default.
    try {
      const formPrefs = await this.db.query<{ hide_extra_asset_fields: boolean }>(
        `SELECT c.hide_extra_asset_fields
         FROM companies c JOIN users u ON u.company_id = c.company_id
         WHERE u.id = $1`,
        [userId]
      );
      if (formPrefs.rows[0]) Object.assign(profile, formPrefs.rows[0]);
    } catch {
      // column not migrated yet — client shows every field, as it does today
    }
    // Best-effort terms state — drives the client's re-accept interstitial.
    // Only attached when the tos columns exist (2026-07-17 migration), so a
    // pre-migration DB simply doesn't gate anyone.
    try {
      const tos = await this.db.query<{ tos_accepted_at: string | null; tos_version: string | null }>(
        "SELECT tos_accepted_at, tos_version FROM users WHERE id = $1",
        [userId]
      );
      if (tos.rows[0]) {
        profile.tos_accepted_at = tos.rows[0].tos_accepted_at;
        profile.tos_version = tos.rows[0].tos_version;
        profile.terms_current_version = TERMS_VERSION;
      }
    } catch {
      // tos columns not migrated yet — profile returns without terms gating
    }
    // Best-effort license summary — getStatus fails open internally, so this
    // never blocks login; it just powers the client's plan screen + banners.
    try {
      profile.license = await this.licensing.getStatus(rows[0]!.company_id);
    } catch {
      // licensing tables not migrated yet — profile still returns without it
    }
    // Best-effort: undismissed platform messages for the in-app banner.
    try {
      const msgs = await this.db.query<{ message_id: string; body: string; created_at: string }>(
        `SELECT message_id, body, created_at
         FROM company_admin_messages
         WHERE company_id = $1 AND dismissed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 20`,
        [rows[0]!.company_id]
      );
      profile.admin_messages = msgs.rows;
    } catch {
      // messages table not migrated yet — profile returns without them
    }
    // Working hours — the shop's default window for auto-scheduling. Null hours
    // mean round the clock, which is how the packer behaved before this existed.
    try {
      const hours = await this.db.query<{ work_start_hour: number | null; work_latest_start_hour: number | null }>(
        `SELECT c.work_start_hour, c.work_latest_start_hour
         FROM companies c JOIN users u ON u.company_id = c.company_id
         WHERE u.id = $1`,
        [userId]
      );
      if (hours.rows[0]) Object.assign(profile, hours.rows[0]);
    } catch {
      // work-hour columns not migrated yet — treated as round the clock
    }
    profile.is_platform_admin = this.licensing.isPlatformAdminEmail(rows[0]!.email);
    return profile;
  }

  // Owner-only: set (or clear, with null) the company's price of one watt of
  // electricity. Mirrors the operation-mode owner guard. Returns the refreshed
  // profile so the client can update in place.
  @Post("electricity-price")
  async setElectricityPrice(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z
      .object({ electricity_price_per_kwh: z.coerce.number().min(0).max(1000000).nullable() })
      .safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("electricity_price_per_kwh must be a non-negative number or null.");
    }

    // Owner-only mutation. The guard already loaded the profile, so we gate on
    // the request context instead of re-querying users.
    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the electricity price.");
    }

    await this.db.query(
      "UPDATE companies SET electricity_price_per_kwh = $1 WHERE company_id = $2",
      [parsed.data.electricity_price_per_kwh, companyId]
    );

    // Full profile, never a partial one — see composeProfile.
    return this.composeProfile(userId);
  }

  // Owner-only: set (or clear, with null) the company's hourly shop rate (labour
  // rate used by piece pricing). Mirrors the electricity-price guard.
  @Post("shop-rate")
  async setShopRate(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z
      .object({ shop_rate: z.coerce.number().min(0).max(100000000).nullable() })
      .safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("shop_rate must be a non-negative number or null.");
    }

    // Owner-only mutation. The guard already loaded the profile, so we gate on
    // the request context instead of re-querying users.
    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the shop rate.");
    }

    await this.db.query(
      "UPDATE companies SET shop_rate = $1 WHERE company_id = $2",
      [parsed.data.shop_rate, companyId]
    );

    // Full profile, never a partial one — see composeProfile.
    return this.composeProfile(userId);
  }

  // Owner-only: choose whether full slicer files are stored on our servers
  // (true, default) or only their parsed header metadata is kept (false —
  // "metadata only": the heavy file is never uploaded, staying the client's
  // responsibility). Mirrors the other owner-only company-setting guards.
  @Post("slicer-storage-mode")
  async setSlicerStorageMode(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z.object({ store_full: z.boolean() }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("store_full must be a boolean.");
    }

    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the slicer storage mode.");
    }

    await this.db.query(
      "UPDATE companies SET store_full_slicer_files = $1 WHERE company_id = $2",
      [parsed.data.store_full, companyId]
    );

    // Full profile, never a partial one — see composeProfile.
    return this.composeProfile(userId);
  }

  // Owner-only: the master switch for AUTOMATIC customer messages — the order
  // shipping-stage emails and the auto-emailed customer invoice. Off means the
  // automatic senders skip this company entirely; it does NOT silence PrintExec's
  // own billing mail to the owner, nor an operator pressing "send" by hand.
  @Post("automated-messages")
  async setAutomatedMessages(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z.object({ automated_messages_enabled: z.boolean() }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("automated_messages_enabled must be a boolean.");
    }

    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change automated messages.");
    }

    await this.db.query(
      "UPDATE companies SET automated_messages_enabled = $1 WHERE company_id = $2",
      [parsed.data.automated_messages_enabled, companyId]
    );

    // Full profile, never a partial one — see composeProfile.
    return this.composeProfile(userId);
  }

  // Owner-only: the house default for how much of an asset intake form is shown
  // at once. Display only — nothing on the server reads this back, and no asset
  // data changes shape because of it. Owner-set because the alternative is every
  // operator tidying the same five forms for themselves.
  @Post("extra-asset-fields")
  async setExtraAssetFields(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z.object({ hide_extra_asset_fields: z.boolean() }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("hide_extra_asset_fields must be a boolean.");
    }

    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the asset form default.");
    }

    await this.db.query(
      "UPDATE companies SET hide_extra_asset_fields = $1 WHERE company_id = $2",
      [parsed.data.hide_extra_asset_fields, companyId]
    );

    // Full profile, never a partial one — see composeProfile.
    return this.composeProfile(userId);
  }

  // Owner-only: the shop's default working hours for auto-scheduling — the
  // window inside which a print may be STARTED. Send nulls to clear it back to
  // round-the-clock. Both hours move together; half a window is meaningless.
  // A plan can still override this per run from the review step.
  @Post("working-hours")
  async setWorkingHours(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const hour = z.number().int().min(0).max(23);
    const parsed = z
      .object({
        work_start_hour: hour.nullable(),
        work_latest_start_hour: hour.nullable(),
      })
      // Either both set or both cleared — mirrors the DB check constraint, so
      // the error is a readable 400 rather than a constraint violation.
      .refine(
        (v) => (v.work_start_hour === null) === (v.work_latest_start_hour === null),
        { message: "Set both hours, or clear both for round-the-clock." }
      )
      // Equal hours would leave a zero-length window, which the packer treats as
      // no restriction anyway — reject it rather than save something inert.
      .refine(
        (v) => v.work_start_hour === null || v.work_start_hour !== v.work_latest_start_hour,
        { message: "Start and latest-start can't be the same hour — that leaves no window." }
      )
      .safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? "Working hours must be whole hours from 0 to 23."
      );
    }

    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the working hours.");
    }

    await this.db.query(
      "UPDATE companies SET work_start_hour = $1, work_latest_start_hour = $2 WHERE company_id = $3",
      [parsed.data.work_start_hour, parsed.data.work_latest_start_hour, companyId]
    );
    return this.composeProfile(userId);
  }

  // POST operation-mode is GONE. It switched the company between 'advanced' and
  // 'simple' back when both workspaces existed. Advanced is retired end to end —
  // the client has no toggle and no Advanced UI to switch into — so the only
  // thing this endpoint could still do was strand a company in a mode with no
  // interface. It is deliberately not replaced by a 410 stub: no client has
  // called it since Advanced was retired, and a route that exists invites a
  // caller. companies.operation_mode itself is left alone (dropping a NOT NULL
  // column is a separate, riskier migration) — it is now inert everywhere that
  // reads it.

  // Owner-only: set (or clear, with null) the company's logo URL. The file
  // itself is uploaded first via the generic POST /uploads, then its returned
  // URL is persisted here — mirrors the STL-thumbnail two-step pattern
  // (upload, then attach the URL to the owning row).
  @Post("company-logo")
  async setCompanyLogo(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z.object({ logo_url: z.string().max(500).nullable() }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("logo_url must be a string or null.");
    }

    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the company logo.");
    }

    await this.db.query(
      "UPDATE companies SET logo_url = $1 WHERE company_id = $2",
      [parsed.data.logo_url, companyId]
    );

    // Full profile, never a partial one — see composeProfile.
    return this.composeProfile(userId);
  }

  // Owner-only: set the company's slogan and about paragraph, shown on the
  // Settings > Brand page. Mirrors the other owner-only company-setting
  // guards. Empty strings are stored as null (cleared), matching pricing's
  // "" → null convention.
  @Post("company-branding")
  async setCompanyBranding(
    @UserId() userId: string,
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z
      .object({
        slogan: z.string().max(200).nullable(),
        about_text: z.string().max(2000).nullable()
      })
      .safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("slogan must be at most 200 characters and about_text at most 2000.");
    }

    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the company brand.");
    }

    await this.db.query(
      "UPDATE companies SET slogan = $1, about_text = $2 WHERE company_id = $3",
      [parsed.data.slogan?.trim() || null, parsed.data.about_text?.trim() || null, companyId]
    );

    // Full profile, never a partial one — see composeProfile.
    return this.composeProfile(userId);
  }

  // Owner-only: the customer-showcase consent flag — permission to use this
  // company's NAME and LOGO to identify them as a PrintExec customer in our
  // marketing. Deliberately narrow: it does NOT cover testimonials, quotes,
  // case studies or business metrics, each of which needs its own signed
  // release. Withdrawal clears the timestamp too, so the row alone answers
  // "is consent live, and since when?".
  //
  // Returns only the flags; the client merges them into the profile it already
  // holds rather than swapping the whole object (which would drop license and
  // terms state that this query doesn't select).
  @Post("company-showcase")
  async setCompanyShowcase(
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z.object({ showcase_opt_in: z.boolean() }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("showcase_opt_in must be true or false.");
    }
    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change marketing consent.");
    }

    const optIn = parsed.data.showcase_opt_in;
    try {
      await this.db.query(
        `UPDATE companies
            SET showcase_opt_in = $1,
                showcase_opt_in_at = CASE WHEN $1 THEN now() ELSE NULL END
          WHERE company_id = $2`,
        [optIn, companyId]
      );
    } catch (err) {
      this.logger.warn(
        `Could not persist showcase_opt_in for ${companyId} (migration pending?): ${err instanceof Error ? err.message : err}`
      );
      throw new BadRequestException("Marketing consent isn't available yet — please try again later.");
    }

    const { rows } = await this.db.query<{ showcase_opt_in: boolean; showcase_opt_in_at: string | null }>(
      "SELECT showcase_opt_in, showcase_opt_in_at FROM companies WHERE company_id = $1",
      [companyId]
    );
    return { ok: true, ...(rows[0] ?? { showcase_opt_in: optIn, showcase_opt_in_at: null }) };
  }

  // Owner-only: turn the Lorelei AI analyst on or off for this workspace.
  // Sits BENEATH the global AI_ANALYST_ENABLED env switch — this only decides
  // whether an already-available feature is active for this tenant. Off by
  // default, because enabling it means workspace data (customer names, revenue,
  // receivables) starts reaching a third-party model on each question.
  @Post("company-ai")
  async setCompanyAi(
    @CompanyId() companyId: string,
    @UserRole() role: "owner" | "staff",
    @Body() body: unknown
  ) {
    const parsed = z.object({ ai_analyst_enabled: z.boolean() }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("ai_analyst_enabled must be true or false.");
    }
    if (role !== "owner") {
      throw new UnauthorizedException("Only the company owner can turn the AI analyst on or off.");
    }

    try {
      await this.db.query(
        "UPDATE companies SET ai_analyst_enabled = $1 WHERE company_id = $2",
        [parsed.data.ai_analyst_enabled, companyId]
      );
    } catch (err) {
      this.logger.warn(
        `Could not persist ai_analyst_enabled for ${companyId} (migration pending?): ${err instanceof Error ? err.message : err}`
      );
      throw new BadRequestException("The AI analyst setting isn't available yet — please try again later.");
    }

    return { ok: true, ai_analyst_enabled: parsed.data.ai_analyst_enabled };
  }

  // Email-existence pre-check. Called from the account step BEFORE the client
  // runs supabase.auth.signUp, so the verification email never fires for an
  // address that can already sign in. Three outcomes:
  //   409                                → a finished account (users row) OR a
  //     confirmed auth user who never completed setup — either way they should
  //     sign in, not sign up again (signing in routes them to setup if needed).
  //   200 { status: "unconfirmed" }      → an earlier signup stalled before the
  //     email was confirmed. Signup may proceed: supabase.auth.signUp re-sends
  //     the confirmation email for existing unconfirmed users, and the client
  //     uses the status to explain the resend on its verify screen.
  //   200 { status: "new" }              → genuinely fresh address.
  // Without the auth.users check, a half-registered user (auth user created,
  // setup never finished) passed this check forever — the "redo the whole
  // signup again and again" loop.
  // Mirror a Supabase-confirmed email change into the app's own tables. The
  // client calls this on the USER_UPDATED auth event: the (fresh) JWT already
  // carries the NEW address, so the token itself is the proof — no body needed.
  // @Public() + direct verify because the global guard reads the users row,
  // which is exactly what's stale here.
  @Public()
  @Post("sync-email")
  async syncEmail(@Headers("authorization") authHeader: string) {
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing token.");
    }
    const token = authHeader.slice(7);
    const { userId, email } = await verifyToken(token, this.supabaseUrl, this.supabaseKey);
    if (!email) return { ok: false };

    await this.db.query(
      `UPDATE users SET email = $2
        WHERE id = $1 AND LOWER(email) IS DISTINCT FROM LOWER($2)`,
      [userId, email]
    );
    // Keep the owner-contact denormalizations in step (both were captured from
    // the owner's login email at setup). Best-effort: schema drift here must
    // never fail the sync of the users row above.
    try {
      await this.db.query(
        `UPDATE companies SET owner_email = $2, email = $2
          WHERE owner_user_id = $1`,
        [userId, email]
      );
    } catch {
      // older schema without these columns — nothing to sync
    }
    return { ok: true, email };
  }

  @Public()
  @Post("check-email")
  async checkEmail(@Body() body: unknown) {
    const parsed = z.object({ email: z.string().max(200) }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("Invalid request.");
    }
    const email = parsed.data.email.trim();
    if (!email) return { available: true, status: "new" };

    const { rows } = await this.db.query(
      "SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [email]
    );
    if (rows.length) {
      throw new ConflictException("An account already exists with this email. Want to sign in instead?");
    }

    // Best-effort look at Supabase's auth store (DATABASE_URL points at the
    // same Postgres). Never let a permissions/schema surprise block signups —
    // on any failure fall through to "new" and let signUp sort it out.
    try {
      const auth = await this.db.query<{ confirmed: boolean }>(
        `SELECT (email_confirmed_at IS NOT NULL) AS confirmed
         FROM auth.users
         WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL
         LIMIT 1`,
        [email]
      );
      if (auth.rows.length) {
        if (auth.rows[0]!.confirmed) {
          throw new ConflictException("An account already exists with this email. Want to sign in instead?");
        }
        return { available: true, status: "unconfirmed" };
      }
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // auth schema unreadable — degrade to the pre-existing behaviour
    }
    return { available: true, status: "new" };
  }

  @Public()
  @Post("setup")
  async setup(
    @Headers("authorization") authHeader: string,
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined
  ) {
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing token.");
    }

    // Verify the token directly. Stays @Public() because the users row is
    // created here, so the global guard's profile lookup would 401 first.
    const token = authHeader.slice(7);
    const { userId, email } = await verifyToken(token, this.supabaseUrl, this.supabaseKey);

    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Invalid request.");
    }

    const existing = await this.db.query(
      "SELECT id FROM users WHERE id = $1",
      [userId]
    );
    if (existing.rows.length) {
      // This branch used to return the profile unconditionally, which meant a
      // staff submission carrying a perfectly valid invite code had that code
      // DISCARDED in silence — never validated, never consumed, no error — and
      // the person was dropped back into the workspace they already had. Anyone
      // who has ever held a PrintExec account (their own trial, an abandoned
      // signup) lands here, and from their side it is indistinguishable from
      // "the invite code doesn't work".
      //
      // Retry-safe by construction: if the code was consumed BY THIS USER then
      // the join already landed and this is a duplicate submit (a lost
      // response, a double click, a 30s client abort), so handing back the
      // profile is the correct idempotent answer. Any OTHER real code cannot be
      // used by this account, and saying so is strictly better than swallowing
      // it. A code that doesn't resolve at all falls through unchanged — an
      // already-set-up account gains nothing from a 404 about a typo.
      if (parsed.data.role === "staff") {
        const token = canonicalizeInviteToken(parsed.data.invite_token ?? "");
        if (token) {
          // Fails OPEN. This lookup only improves an error message — it is not
          // a gate — so a schema surprise must degrade to the old behaviour
          // (hand back the profile) rather than turn a working request into a
          // 500. used_by is write-only everywhere else in the codebase, and
          // the only writer is the redemption UPDATE below, which could not
          // have run while the byte-exact match was rejecting every code. So
          // this is the first read of that column, and it must not be the
          // thing that breaks setup if the column is not there.
          let invite: { used_by: string | null } | undefined;
          try {
            const claimed = await this.db.query<{ used_by: string | null }>(
              "SELECT used_by FROM company_invites WHERE token = $1",
              [token]
            );
            invite = claimed.rows[0];
          } catch (err) {
            this.logger.warn(
              `Could not check invite ownership for an already-set-up account: ${err instanceof Error ? err.message : err}`
            );
          }
          if (invite && invite.used_by !== userId) {
            // NOTE: AuthPage.tsx (client) matches this string EXACTLY to route
            // the error onto the invite-code field. Change both repos in
            // lockstep. Deliberately one message for both "code is live" and
            // "code was spent by someone else" — this account can't use either,
            // and distinguishing them would leak invite state to any signed-in
            // caller willing to guess.
            throw new ConflictException(
              "This account already belongs to a workspace, so it can't accept an invite code. Ask the owner to invite a different email address."
            );
          }
        }
      }
      // Already set up — hand back the same full profile /auth/me would.
      return this.composeProfile(userId);
    }

    // Terms of Use click-wrap: hard requirement for every NEW account, owner
    // and staff alike — the signup flow can't submit without the checkbox, so
    // a missing flag means an out-of-band caller. Checked BEFORE any row is
    // written; enforced in code (not the schema) so the copy is exact.
    if (parsed.data.terms_accepted !== true) {
      throw new BadRequestException("Please agree to the Terms of Use to continue.");
    }

    // Required display name (owner + staff). Empty → 400; single char → 400.
    const displayName = (parsed.data.display_name ?? "").trim();
    if (!displayName) {
      throw new BadRequestException("Your name is required.");
    }
    if (displayName.length < 2) {
      throw new BadRequestException("Please enter your full name.");
    }

    if (parsed.data.role === "owner") {
      const companyName = (parsed.data.company_name ?? "").trim();
      if (!companyName) {
        throw new BadRequestException("Company name is required.");
      }

      // Required company-profile fields (mirrors the client form). Optional fields
      // (website, address, postal code, timezone, tax id) remain nullable.
      if (!(parsed.data.industry ?? "").trim()) {
        throw new BadRequestException("Industry is required.");
      }
      if (!(parsed.data.company_size ?? "").trim()) {
        throw new BadRequestException("Company size is required.");
      }
      if (!(parsed.data.city ?? "").trim()) {
        throw new BadRequestException("City is required.");
      }
      if (!(parsed.data.currency_default ?? "").trim()) {
        throw new BadRequestException("Currency is required.");
      }

      // (1) email already used by a *different* account
      const emailDupe = await this.db.query(
        "SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2",
        [email, userId]
      );
      if (emailDupe.rows.length) {
        throw new ConflictException("An account already exists with this email. Want to sign in instead?");
      }

      // (4) this owner already has a company with this name
      const companyDupe = await this.db.query(
        "SELECT company_id FROM companies WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2)",
        [userId, companyName]
      );
      if (companyDupe.rows.length) {
        // NOTE: AuthPage.tsx (client) matches this string EXACTLY to route the
        // error onto the company-name field. Change both repos in lockstep.
        throw new ConflictException("You already have a company with this name on your account.");
      }

      // (5) currency must be a 3-letter ISO 4217 code when provided
      const currency = parsed.data.currency_default;
      if (currency !== undefined && currency !== "" && !/^[A-Z]{3}$/.test(currency)) {
        throw new BadRequestException("Currency must be a 3-letter ISO code (e.g. EGP, USD, EUR).");
      }

      // (6) timezone must resolve to a real IANA zone when provided — but
      // leniently: the value is normalized case-insensitively to its canonical
      // form ("africa/cairo" → "Africa/Cairo") and the canonical form is what
      // gets stored, so a direct API caller isn't held to exact casing either.
      const normalizedTimezone = normalizeTimezone(parsed.data.timezone);
      if (parsed.data.timezone && normalizedTimezone === null) {
        throw new BadRequestException("Please enter a valid timezone (e.g. Africa/Cairo, Europe/London).");
      }

      // (7) company size must be one of the known buckets when provided
      const size = parsed.data.company_size;
      if (size !== undefined && size !== "" && !["solo", "2-10", "11-50", "51-200", "200+"].includes(size)) {
        throw new BadRequestException("Invalid company size value.");
      }

      const slug = companyName
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 60);

      const uniqueSlug = `${slug}-${Date.now().toString(36)}`;

      // tenant_code (the stable "ABC" prefix for this company's order numbers)
      // is assigned automatically by a BEFORE INSERT trigger on companies
      // (2026-07-04_tenant_order_numbering.sql): derived once from the name and
      // de-duplicated to stay globally unique, so it never changes if the name
      // later does. We deliberately do not set it here — letting the trigger own
      // assignment is what keeps it race-safe under concurrent signups.
      const ownerPerms = {
        view_orders: true, action_orders: true,
        view_customers: true, action_customers: true,
        view_assets: true, action_assets: true,
        can_send_invites: true, can_manage_permissions: true
      };

      // Narrowed owner variant, captured so the union narrowing survives into
      // the transaction closure below.
      const owner = parsed.data;

      // All-or-nothing: company + owner user + membership are ONE signup. A
      // mid-flight failure used to strand an orphaned companies row, and the
      // duplicate-name check above then rejected every retry ("You already
      // have a company with this name") — a permanently stuck signup.
      const companyId = await this.db.transaction(async (client) => {
        const company = await this.db.query<{ company_id: string }>(
          `INSERT INTO companies (
             name, slug, email, owner_user_id,
             city, address_line_1, address_line_2, postal_code,
             website, industry, company_size, tax_id,
             currency_default, timezone,
             owner_account_id, owner_display_name, owner_email,
             operation_mode
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'simple')
           RETURNING company_id`,
          [
            companyName, uniqueSlug, email, userId,
            owner.city             ?? null,
            owner.address_line_1   ?? null,
            owner.address_line_2   ?? null,
            owner.postal_code      ?? null,
            owner.website          ?? null,
            owner.industry         ?? null,
            owner.company_size     ?? null,
            owner.tax_id           ?? null,
            owner.currency_default ?? null,
            normalizedTimezone,
            userId,
            displayName,
            email
          ],
          client
        );

        const newCompanyId = company.rows[0]!.company_id;

        await this.db.query(
          `INSERT INTO users (id, company_id, email, display_name, role, permissions)
           VALUES ($1, $2, $3, $4, 'owner', $5)`,
          [userId, newCompanyId, email, displayName, JSON.stringify(ownerPerms)],
          client
        );

        await this.db.query(
          `INSERT INTO company_memberships (company_id, account_id, role, permissions)
           VALUES ($1, $2, 'owner', $3)`,
          [newCompanyId, userId, JSON.stringify(ownerPerms)],
          client
        );

        await this.db.query(
          `UPDATE users SET companies_owned = array_append(companies_owned, $1::uuid)
           WHERE id = $2`,
          [newCompanyId, userId],
          client
        );

        return newCompanyId;
      });

      // Start the new company's trial, carrying the plan picked on the signup
      // plan step (checkout intent while payments are offline — everyone runs
      // on the trial regardless). Best-effort: signup must never break on
      // licensing (e.g. the licensing migration not applied yet) — the
      // license resolver lazily provisions the trial row on first use anyway.
      try {
        await this.licensing.ensureTrial(
          companyId,
          undefined,
          owner.plan_code && owner.plan_code !== "trial" ? owner.plan_code : null
        );
      } catch {
        // licensing tables not migrated yet — resolver will self-heal
      }

      // Marketing consent from the signup card. Only written when explicitly
      // true — the column already defaults to false, so an absent or false
      // value needs no write at all. Kept out of the company INSERT and
      // best-effort on purpose: a pre-migration column must never roll back a
      // finished signup, and "we failed to record a yes" degrades to "no",
      // which is the safe direction for a consent flag.
      if (owner.showcase_opt_in === true) {
        try {
          await this.db.query(
            "UPDATE companies SET showcase_opt_in = TRUE, showcase_opt_in_at = now() WHERE company_id = $1",
            [companyId]
          );
        } catch (err) {
          this.logger.warn(
            `Could not record showcase_opt_in at signup for ${companyId} (migration pending?): ${err instanceof Error ? err.message : err}`
          );
        }
      }

      // Durable click-wrap record (audit row + users stamp) — after the
      // transaction so a pre-migration terms table can never roll back a
      // finished signup.
      await this.recordTermsAcceptance(userId, email, ip ?? null, userAgent ?? null);

      return { user_id: userId, company_id: companyId, company_name: companyName, role: "owner", permissions: ownerPerms, display_name: displayName, email };
    }

    // staff — validate invite with precise, split checks for exact status codes
    const rawInviteToken = (parsed.data.invite_token ?? "").trim();
    if (!rawInviteToken) {
      throw new BadRequestException("Invite code is required.");
    }

    // Fold what they typed onto the stored format BEFORE the lookup. The query
    // below is byte-exact and codes are minted as ABCD-EFGH, so without this a
    // correct code entered without the dash — or pasted with an en-dash, a
    // non-breaking hyphen or a zero-width space out of the invite email — was
    // answered "This invite code doesn't exist", which is both false and the
    // one message guaranteed to make someone retype the identical thing.
    // canonicalizeInviteToken only strips separators and normalizes case; it
    // never folds one code glyph into another, so it cannot widen the match
    // onto a different company's live code. See staff/invite-token.ts.
    const inviteToken = canonicalizeInviteToken(rawInviteToken);
    if (!inviteToken) {
      // Malformed → deliberately the SAME 404 as a genuine miss. A distinct
      // "that isn't a code" message would read better, but it would also tell a
      // caller which guesses are shaped correctly, and AuthPage matches these
      // strings exactly to route the error onto the invite field — reusing this
      // one keeps the two repos in step with no client change.
      throw new NotFoundException("This invite code doesn't exist. Check the code and try again.");
    }

    const inviteRow = await this.db.query<{ company_id: string; used_at: string | Date | null; expires_at: string | Date }>(
      "SELECT company_id, used_at, expires_at FROM company_invites WHERE token = $1",
      [inviteToken]
    );

    // (8) token doesn't exist
    if (!inviteRow.rows.length) {
      throw new NotFoundException("This invite code doesn't exist. Check the code and try again.");
    }
    const inv = inviteRow.rows[0]!;
    // (9) already used
    if (inv.used_at !== null) {
      throw new ConflictException("This invite code has already been used.");
    }
    // (10) expired
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      throw new GoneException("This invite code has expired. Ask the company owner to send a new one.");
    }

    const companyId = inv.company_id;

    // (11) already a member of this company
    const member = await this.db.query(
      "SELECT 1 FROM company_memberships WHERE account_id = $1 AND company_id = $2",
      [userId, companyId]
    );
    if (member.rows.length) {
      throw new ConflictException("You are already a member of this company.");
    }

    const emptyPerms = {};

    // All-or-nothing, and the invite is CLAIMED first with a compare-and-set:
    // two people racing the same code can both pass the friendly checks above,
    // but only one "WHERE used_at IS NULL" update wins — the loser's whole
    // membership rolls back instead of leaving half-created rows.
    await this.db.transaction(async (client) => {
      const claimed = await this.db.query(
        `UPDATE company_invites SET used_at = now(), used_by = $1
          WHERE token = $2 AND used_at IS NULL`,
        [userId, inviteToken],
        client
      );
      if (!claimed.rowCount) {
        throw new ConflictException("This invite code has already been used.");
      }

      await this.db.query(
        `INSERT INTO users (id, company_id, email, display_name, role, permissions)
         VALUES ($1, $2, $3, $4, 'staff', $5)`,
        [userId, companyId, email, displayName, JSON.stringify(emptyPerms)],
        client
      );

      await this.db.query(
        `INSERT INTO company_memberships (company_id, account_id, role, permissions)
         VALUES ($1, $2, 'staff', '{}')`,
        [companyId, userId],
        client
      );

      await this.db.query(
        `UPDATE users SET companies_joined = array_append(companies_joined, $1::uuid)
         WHERE id = $2`,
        [companyId, userId],
        client
      );
    });

    // Same durable click-wrap record as the owner path (post-transaction).
    await this.recordTermsAcceptance(userId, email, ip ?? null, userAgent ?? null);

    const { rows: companyRows } = await this.db.query<{ name: string }>(
      "SELECT name FROM companies WHERE company_id = $1",
      [companyId]
    );
    return { user_id: userId, company_id: companyId, company_name: companyRows[0]?.name ?? "", role: "staff", permissions: emptyPerms, display_name: displayName, email };
  }
}
