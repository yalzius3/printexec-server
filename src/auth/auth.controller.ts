import { Body, Controller, Get, Post, Res, UnauthorizedException, BadRequestException, ConflictException, NotFoundException, GoneException, Headers } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient } from "@supabase/supabase-js";
import type { FastifyReply } from "fastify";
import { DatabaseService } from "../database/database.service";
import { CompanyId } from "../common/company-id.decorator";
import { Public } from "./public.decorator";
import { buildUploadCookieHeader, signUploadCookie } from "./upload-cookie";
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
  timezone: z.string().max(60).optional()
});

const staffSetupSchema = z.object({
  role: z.literal("staff"),
  invite_token: z.string().max(120).optional(),
  display_name: z.string().max(80).optional()
});

const setupSchema = z.discriminatedUnion("role", [ownerSetupSchema, staffSetupSchema]);

@Controller("auth")
export class AuthController {
  private readonly supabase;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService
  ) {
    this.supabase = createClient(
      config.getOrThrow("SUPABASE_URL"),
      config.getOrThrow("SUPABASE_SERVICE_ROLE_KEY")
    );
  }

  // Issue (or refresh) the HttpOnly upload-session cookie. Runs through the
  // global SupabaseAuthGuard (Bearer), so req.companyId is already populated.
  // The cookie authorizes same-origin GETs of guarded uploads that cannot carry
  // a Bearer header (<img>/<iframe>/<a download>/STL viewer fetch). The client
  // calls this on every session change (login + token refresh).
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
    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) {
      console.error("[auth/me] getUser failed:", { message: error?.message, status: error?.status, name: error?.name });
      throw new UnauthorizedException(`Invalid token: ${error?.message ?? "no user"}`);
    }

    const { rows } = await this.db.query<{ user_id: string; company_id: string; company_name: string; operation_mode: string; role: string; permissions: Record<string, boolean>; display_name: string | null; email: string; electricity_price_per_kwh: string | null; shop_rate: string | null }>(
      `SELECT u.id AS user_id, u.company_id, c.name AS company_name, c.operation_mode, u.role, u.permissions, u.display_name, u.email, c.electricity_price_per_kwh, c.shop_rate
       FROM users u JOIN companies c ON c.company_id = u.company_id
       WHERE u.id = $1`,
      [data.user.id]
    );
    if (!rows.length) return null;
    return rows[0];
  }

  // Owner-only: set (or clear, with null) the company's price of one watt of
  // electricity. Mirrors the operation-mode owner guard. Returns the refreshed
  // profile so the client can update in place.
  @Public()
  @Post("electricity-price")
  async setElectricityPrice(
    @Headers("authorization") authHeader: string,
    @Body() body: unknown
  ) {
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing token.");
    }
    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new UnauthorizedException(`Invalid token: ${error?.message ?? "no user"}`);
    }

    const parsed = z
      .object({ electricity_price_per_kwh: z.coerce.number().min(0).max(1000000).nullable() })
      .safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("electricity_price_per_kwh must be a non-negative number or null.");
    }

    const me = await this.db.query<{ company_id: string; role: string }>(
      "SELECT company_id, role FROM users WHERE id = $1",
      [data.user.id]
    );
    const owner = me.rows[0];
    if (!owner) {
      throw new NotFoundException("No company for this user.");
    }
    if (owner.role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the electricity price.");
    }

    await this.db.query(
      "UPDATE companies SET electricity_price_per_kwh = $1 WHERE company_id = $2",
      [parsed.data.electricity_price_per_kwh, owner.company_id]
    );

    const { rows } = await this.db.query(
      `SELECT u.id AS user_id, u.company_id, c.name AS company_name, c.operation_mode, u.role, u.permissions, u.display_name, u.email, c.electricity_price_per_kwh, c.shop_rate
       FROM users u JOIN companies c ON c.company_id = u.company_id
       WHERE u.id = $1`,
      [data.user.id]
    );
    return rows[0] ?? null;
  }

  // Owner-only: set (or clear, with null) the company's hourly shop rate (labour
  // rate used by piece pricing). Mirrors the electricity-price guard.
  @Public()
  @Post("shop-rate")
  async setShopRate(
    @Headers("authorization") authHeader: string,
    @Body() body: unknown
  ) {
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing token.");
    }
    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new UnauthorizedException(`Invalid token: ${error?.message ?? "no user"}`);
    }

    const parsed = z
      .object({ shop_rate: z.coerce.number().min(0).max(100000000).nullable() })
      .safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("shop_rate must be a non-negative number or null.");
    }

    const me = await this.db.query<{ company_id: string; role: string }>(
      "SELECT company_id, role FROM users WHERE id = $1",
      [data.user.id]
    );
    const owner = me.rows[0];
    if (!owner) {
      throw new NotFoundException("No company for this user.");
    }
    if (owner.role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the shop rate.");
    }

    await this.db.query(
      "UPDATE companies SET shop_rate = $1 WHERE company_id = $2",
      [parsed.data.shop_rate, owner.company_id]
    );

    const { rows } = await this.db.query(
      `SELECT u.id AS user_id, u.company_id, c.name AS company_name, c.operation_mode, u.role, u.permissions, u.display_name, u.email, c.electricity_price_per_kwh, c.shop_rate
       FROM users u JOIN companies c ON c.company_id = u.company_id
       WHERE u.id = $1`,
      [data.user.id]
    );
    return rows[0] ?? null;
  }

  // Owner-only: switch the company between 'advanced' and 'simple'. Soft — it
  // never blocks; the client warns when the other mode still has active work.
  // Returns the refreshed profile so the client can update in place.
  @Public()
  @Post("operation-mode")
  async setOperationMode(
    @Headers("authorization") authHeader: string,
    @Body() body: unknown
  ) {
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing token.");
    }
    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new UnauthorizedException(`Invalid token: ${error?.message ?? "no user"}`);
    }

    const parsed = z.object({ mode: z.enum(["advanced", "simple"]) }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("mode must be 'advanced' or 'simple'.");
    }

    const me = await this.db.query<{ company_id: string; role: string }>(
      "SELECT company_id, role FROM users WHERE id = $1",
      [data.user.id]
    );
    const owner = me.rows[0];
    if (!owner) {
      throw new NotFoundException("No company for this user.");
    }
    if (owner.role !== "owner") {
      throw new UnauthorizedException("Only the company owner can change the operation mode.");
    }

    await this.db.query(
      "UPDATE companies SET operation_mode = $1 WHERE company_id = $2",
      [parsed.data.mode, owner.company_id]
    );

    const { rows } = await this.db.query(
      `SELECT u.id AS user_id, u.company_id, c.name AS company_name, c.operation_mode, u.role, u.permissions, u.display_name, u.email, c.electricity_price_per_kwh, c.shop_rate
       FROM users u JOIN companies c ON c.company_id = u.company_id
       WHERE u.id = $1`,
      [data.user.id]
    );
    return rows[0] ?? null;
  }

  // Email-existence pre-check. Called from the account step BEFORE the client
  // runs supabase.auth.signUp, so the verification email never fires for an
  // address that already has an account. Mirrors the dupe check in setup().
  @Public()
  @Post("check-email")
  async checkEmail(@Body() body: unknown) {
    const parsed = z.object({ email: z.string().max(200) }).safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException("Invalid request.");
    }
    const email = parsed.data.email.trim();
    if (email) {
      const { rows } = await this.db.query(
        "SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
        [email]
      );
      if (rows.length) {
        throw new ConflictException("An account already exists with this email. Want to sign in instead?");
      }
    }
    return { available: true };
  }

  @Public()
  @Post("setup")
  async setup(
    @Headers("authorization") authHeader: string,
    @Body() body: unknown
  ) {
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing token.");
    }

    const token = authHeader.slice(7);
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) {
      console.error("[auth/setup] getUser failed:", { message: error?.message, status: error?.status, name: error?.name, tokenPrefix: token.slice(0, 20), supabaseUrl: this.config.get("SUPABASE_URL") });
      throw new UnauthorizedException(`Invalid token: ${error?.message ?? "no user"}`);
    }

    const userId = data.user.id;
    const email = data.user.email!;

    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "Invalid request.");
    }

    const existing = await this.db.query(
      "SELECT id FROM users WHERE id = $1",
      [userId]
    );
    if (existing.rows.length) {
      const user = await this.db.query(
        `SELECT u.id AS user_id, u.company_id, c.name AS company_name, c.operation_mode, u.role, u.permissions, u.display_name, u.email, c.electricity_price_per_kwh, c.shop_rate
         FROM users u JOIN companies c ON c.company_id = u.company_id
         WHERE u.id = $1`,
        [userId]
      );
      return user.rows[0];
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
        throw new ConflictException("You already have a company with this name on your WRKXYZ account.");
      }

      // (5) currency must be a 3-letter ISO 4217 code when provided
      const currency = parsed.data.currency_default;
      if (currency !== undefined && currency !== "" && !/^[A-Z]{3}$/.test(currency)) {
        throw new BadRequestException("Currency must be a 3-letter ISO code (e.g. EGP, USD, EUR).");
      }

      // (6) timezone must be a valid IANA zone when provided
      const tz = parsed.data.timezone;
      if (tz !== undefined && tz !== "") {
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: tz });
        } catch {
          throw new BadRequestException("Please enter a valid timezone (e.g. Africa/Cairo, Europe/London).");
        }
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

      const company = await this.db.query<{ company_id: string }>(
        `INSERT INTO companies (
           name, slug, email, owner_user_id,
           city, address_line_1, address_line_2, postal_code,
           website, industry, company_size, tax_id,
           currency_default, timezone,
           owner_wrkxyz_id, owner_display_name, owner_email
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING company_id`,
        [
          companyName, uniqueSlug, email, userId,
          parsed.data.city             ?? null,
          parsed.data.address_line_1   ?? null,
          parsed.data.address_line_2   ?? null,
          parsed.data.postal_code      ?? null,
          parsed.data.website          ?? null,
          parsed.data.industry         ?? null,
          parsed.data.company_size     ?? null,
          parsed.data.tax_id           ?? null,
          parsed.data.currency_default ?? null,
          parsed.data.timezone         ?? null,
          userId,
          displayName,
          email
        ]
      );

      const companyId = company.rows[0]!.company_id;
      const ownerPerms = {
        view_orders: true, action_orders: true,
        view_customers: true, action_customers: true,
        view_assets: true, action_assets: true,
        can_send_invites: true, can_manage_permissions: true
      };

      await this.db.query(
        `INSERT INTO users (id, company_id, email, display_name, role, permissions)
         VALUES ($1, $2, $3, $4, 'owner', $5)`,
        [userId, companyId, email, displayName, JSON.stringify(ownerPerms)]
      );

      await this.db.query(
        `INSERT INTO company_memberships (company_id, wrkxyz_account_id, role, permissions)
         VALUES ($1, $2, 'owner', $3)`,
        [companyId, userId, JSON.stringify(ownerPerms)]
      );

      await this.db.query(
        `UPDATE users SET companies_owned = array_append(companies_owned, $1::uuid)
         WHERE id = $2`,
        [companyId, userId]
      );

      return { user_id: userId, company_id: companyId, company_name: companyName, role: "owner", permissions: ownerPerms, display_name: displayName, email };
    }

    // staff — validate invite with precise, split checks for exact status codes
    const inviteToken = (parsed.data.invite_token ?? "").trim();
    if (!inviteToken) {
      throw new BadRequestException("Invite code is required.");
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
      "SELECT 1 FROM company_memberships WHERE wrkxyz_account_id = $1 AND company_id = $2",
      [userId, companyId]
    );
    if (member.rows.length) {
      throw new ConflictException("You are already a member of this company.");
    }

    const emptyPerms = {};

    await this.db.query(
      `INSERT INTO users (id, company_id, email, display_name, role, permissions)
       VALUES ($1, $2, $3, $4, 'staff', $5)`,
      [userId, companyId, email, displayName, JSON.stringify(emptyPerms)]
    );

    await this.db.query(
      `INSERT INTO company_memberships (company_id, wrkxyz_account_id, role, permissions)
       VALUES ($1, $2, 'staff', '{}')`,
      [companyId, userId]
    );

    await this.db.query(
      `UPDATE users SET companies_joined = array_append(companies_joined, $1::uuid)
       WHERE id = $2`,
      [companyId, userId]
    );

    await this.db.query(
      `UPDATE company_invites SET used_at = now(), used_by = $1 WHERE token = $2`,
      [userId, inviteToken]
    );

    const { rows: companyRows } = await this.db.query<{ name: string }>(
      "SELECT name FROM companies WHERE company_id = $1",
      [companyId]
    );
    return { user_id: userId, company_id: companyId, company_name: companyRows[0]?.name ?? "", role: "staff", permissions: emptyPerms, display_name: displayName, email };
  }
}
