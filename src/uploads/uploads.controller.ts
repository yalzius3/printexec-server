import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException
} from "@nestjs/common";
import { FastifyRequest, FastifyReply } from "fastify";
import "@fastify/multipart";
import { CompanyId } from "../common/company-id.decorator";
import { Public } from "../auth/public.decorator";
import { UploadCookieGuard } from "../auth/upload-cookie.guard";
import { ConfigService } from "@nestjs/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { v4 as uuidv4 } from "uuid";
import { promisify } from "util";

const inflateRaw = promisify(zlib.inflateRaw);

// Cap inflated ZIP-entry output to defuse zip bombs (a tiny compressed entry
// that expands to gigabytes). 16 MB is far beyond any real slicer config/plate.
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
const TEXT_GCODE_HEAD_LINES = 200;
const TEXT_GCODE_TAIL_LINES = 100;

type SlicerParseResult = {
  slicer_print_time_minutes?: number;
  slicer_filament_used_grams?: number;
  slicer_filament_used_mm?: number;
  slicer_layer_height_mm?: number;
  slicer_infill_percent?: number;
  slicer_support_grams?: number;
  slicer_part_weight_grams?: number;
};

type GcodeFlavor = "prusa" | "bambu" | "cura" | "simplify3d" | "ideamaker" | "unknown";

// Minimal extension → Content-Type map for served uploads. octet-stream is a
// safe default; PDFs and images need accurate types so the browser renders
// them inline in the preview iframe/img.
const CONTENT_TYPES: Record<string, string> = {
  ".stl": "model/stl",
  ".3mf": "model/3mf",
  ".obj": "text/plain",
  ".step": "application/step",
  ".stp": "application/step",
  ".gcode": "text/plain",
  ".gco": "text/plain",
  ".g": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".csv": "text/csv"
};

const UPLOAD_BUCKET = process.env.SUPABASE_UPLOAD_BUCKET || "uploads";

@Controller("uploads")
export class UploadsController {
  private readonly supabase: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      this.config.getOrThrow<string>("SUPABASE_URL"),
      this.config.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY")
    );
  }

  // Guarded file serving. Replaces the former @fastify/static mount, which
  // bypassed all auth and let any party read any company's files by guessing a
  // URL. Authorized via the signed upload-session cookie (UploadCookieGuard,
  // which sets req.companyId); the path's company segment must match. Legacy
  // "/uploads/<company>/<file>" URLs are rerouted to "/api/uploads/..." by the
  // FastifyAdapter rewriteUrl hook in main.ts, so they land here too.
  @Public()
  @UseGuards(UploadCookieGuard)
  @Get(":companyId/:filename")
  async serveFile(
    @Param("companyId") companyIdParam: string,
    @Param("filename") filename: string,
    @CompanyId() companyId: string,
    @Res() reply: FastifyReply
  ) {
    if (companyIdParam !== companyId) {
      throw new ForbiddenException("You do not have access to this file.");
    }
    // Reject any path-traversal in the filename segment.
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      throw new BadRequestException("Invalid file name.");
    }

    // Durable bytes live in Supabase Storage — the Railway container disk is
    // ephemeral (wiped on every restart/redeploy). The object key mirrors the
    // historical on-disk layout: "<companyId>/<filename>".
    const { data, error } = await this.supabase.storage
      .from(UPLOAD_BUCKET)
      .download(`${companyIdParam}/${filename}`);
    if (error || !data) {
      console.error(
        `[uploads] Supabase download failed bucket="${UPLOAD_BUCKET}" key="${companyIdParam}/${filename}":`,
        (error as { message?: string } | null)?.message ?? "no data"
      );
      throw new NotFoundException("File not found.");
    }
    const bytes = Buffer.from(await data.arrayBuffer());

    const contentType = CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
    reply.header("Content-Type", contentType);
    reply.header("Content-Length", bytes.byteLength);
    return reply.send(bytes);
  }

  @Post()
  async uploadFile(
    @Req() req: FastifyRequest,
    @CompanyId() companyId: string
  ) {
    if (!req.isMultipart()) {
      throw new BadRequestException("Request is not multipart");
    }

    const data = await req.file();
    if (!data) {
      throw new BadRequestException("No file uploaded");
    }

    const extension = path.extname(data.filename);
    const filename = `${uuidv4()}${extension}`;
    const objectKey = `${companyId}/${filename}`;

    // Buffer the upload, then persist the durable copy to Supabase Storage. The
    // Railway container disk is ephemeral (wiped on restart/redeploy), so files
    // must live off-box to survive.
    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        throw new PayloadTooLargeException("File exceeds the upload size limit.");
      }
      throw new InternalServerErrorException("Failed to read upload");
    }

    if (data.file.truncated) {
      throw new PayloadTooLargeException("File exceeds the upload size limit.");
    }

    const contentType = CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
    const { error } = await this.supabase.storage
      .from(UPLOAD_BUCKET)
      .upload(objectKey, buffer, { contentType, upsert: false });
    if (error) {
      // Surface the real reason (e.g. "Bucket not found", RLS, size) in logs —
      // the generic 500 below hides it from the operator.
      console.error(
        `[uploads] Supabase upload failed bucket="${UPLOAD_BUCKET}" key="${objectKey}" size=${buffer.length}:`,
        (error as { message?: string; name?: string; statusCode?: string } | null)?.message ?? error
      );
      throw new InternalServerErrorException("Failed to save file");
    }

    // When the client asks (?parse=slicer), best-effort parse the slicer file
    // from the in-memory buffer. Failure is silent — the operator can always
    // type the values.
    const parse = (req.query as { parse?: string } | undefined)?.parse;
    let parsed: SlicerParseResult = {};
    if (parse === "slicer") {
      parsed = await this.parseSlicerFile(buffer, extension);
    }

    // Returned URL is served by the guarded GET route below under the API prefix
    // so it travels through the same proxy/CORS path as the rest of the app.
    return {
      url: `/api/uploads/${companyId}/${filename}`,
      originalName: data.filename,
      size: buffer.length,
      ...(parsed.slicer_print_time_minutes != null ? { slicer_print_time_minutes: parsed.slicer_print_time_minutes } : {}),
      ...(parsed.slicer_filament_used_grams != null ? { slicer_filament_used_grams: parsed.slicer_filament_used_grams } : {}),
    };
  }

  private async parseSlicerFile(
    buffer: Buffer,
    extension: string
  ): Promise<SlicerParseResult> {
    try {
      const ext = extension.toLowerCase();

      if (this.isBgcode(buffer) || ext === ".bgcode") {
        return await this.parseBgcode(buffer);
      }

      if (ext === ".gx") {
        return await this.parseGx(buffer);
      }

      if (ext === ".ctb") {
        return await this.parseCtb(buffer);
      }

      if (ext === ".3mf" || this.isZipBuffer(buffer)) {
        return await this.parseThreeMf(buffer);
      }

      if (ext === ".gcode" || ext === ".gco" || ext === ".g") {
        return await this.parseTextGcode(buffer);
      }

      return {};
    } catch {
      return {};
    }
  }

  private async parseBgcode(buffer: Buffer): Promise<SlicerParseResult> {
    try {
      if (!this.isBgcode(buffer)) return {};
      return this.parseKnownText(buffer.toString("latin1"), "prusa");
    } catch {
      return {};
    }
  }

  private async parseGx(buffer: Buffer): Promise<SlicerParseResult> {
    try {
      if (buffer.length < 0x40) return {};

      const out: SlicerParseResult = {};
      const printTimeSeconds = this.readUInt32LEIfPlausible(buffer, 0x1c, 1, 10_000_000);
      const rightFilamentMm = this.readUInt32LEIfPlausible(buffer, 0x20, 0, 1_000_000_000);
      const leftFilamentMm = this.readUInt32LEIfPlausible(buffer, 0x24, 0, 1_000_000_000);
      const layerHeightMicrons = this.readUInt32LEIfPlausible(buffer, 0x2a, 1, 100_000);

      if (printTimeSeconds != null) {
        const mins = this.normalizeDurationToMinutes(printTimeSeconds, "seconds");
        if (mins != null) out.slicer_print_time_minutes = mins;
      }

      const filamentMm = [rightFilamentMm, leftFilamentMm]
        .filter((value): value is number => value != null)
        .reduce((sum, value) => sum + value, 0);
      if (filamentMm > 0) {
        out.slicer_filament_used_mm = Math.round(filamentMm * 100) / 100;
      }

      if (layerHeightMicrons != null && layerHeightMicrons > 0) {
        out.slicer_layer_height_mm = Math.round((layerHeightMicrons / 1000) * 1000) / 1000;
      }

      return out;
    } catch {
      return {};
    }
  }

  private async parseCtb(buffer: Buffer): Promise<SlicerParseResult> {
    try {
      if (buffer.length < 0x40) return {};

      const out: SlicerParseResult = {};
      const timeCandidates = [0x10, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x28, 0x2c, 0x30];
      for (const offset of timeCandidates) {
        const seconds = this.readUInt32LEIfPlausible(buffer, offset, 1, 100_000_000);
        if (seconds != null) {
          const mins = this.normalizeDurationToMinutes(seconds, "seconds");
          if (mins != null) out.slicer_print_time_minutes = mins;
          break;
        }
      }

      const thicknessCandidates = [0x20, 0x24, 0x28, 0x2c, 0x30, 0x34];
      for (const offset of thicknessCandidates) {
        const thickness = this.readFloatLEIfPlausible(buffer, offset, 0.001, 10);
        if (thickness != null) {
          out.slicer_layer_height_mm = Math.round(thickness * 1000) / 1000;
          break;
        }
      }

      return out;
    } catch {
      return {};
    }
  }

  private async parseThreeMf(buffer: Buffer): Promise<SlicerParseResult> {
    try {
      const text = await this.extractArchiveText(buffer);
      if (!text) return {};
      return this.parseKnownText(text, "unknown");
    } catch {
      return {};
    }
  }

  private async parseTextGcode(buffer: Buffer): Promise<SlicerParseResult> {
    try {
      const text = buffer.toString("latin1");
      if (!text) return {};
      const flavor = this.detectGcodeFlavor(text);
      return this.parseKnownText(text, flavor);
    } catch {
      return {};
    }
  }

  private parseKnownText(text: string, flavor: GcodeFlavor): SlicerParseResult {
    try {
      const out: SlicerParseResult = {};
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        this.consumeKnownLine(out, line, flavor);
      }
      if (flavor !== "unknown" && (!out.slicer_print_time_minutes || !out.slicer_filament_used_grams)) {
        for (const line of lines) {
          this.consumeKnownLine(out, line, "unknown");
        }
      }

      if (out.slicer_print_time_minutes == null) {
        const prediction = text.match(/key="prediction"\s+value="(\d+)"/i)
          ?? text.match(/<prediction>(\d+)<\/prediction>/i);
        if (prediction?.[1]) {
          const mins = this.normalizeDurationToMinutes(Number(prediction[1]), "seconds");
          if (mins != null && mins > 0) out.slicer_print_time_minutes = mins;
        }
      }

      if (out.slicer_filament_used_grams == null) {
        let sum = 0;
        let found = false;
        for (const m of text.matchAll(/used_g="([\d.]+)"/gi)) {
          sum += Number(m[1]);
          found = true;
        }
        if (!found) {
          const weight = text.match(/key="weight"\s+value="([\d.]+)"/i);
          if (weight?.[1]) {
            sum = Number(weight[1]);
            found = true;
          }
        }
        if (found && sum > 0) out.slicer_filament_used_grams = Math.round(sum * 100) / 100;
      }

      return out;
    } catch {
      return {};
    }
  }

  private consumeKnownLine(out: SlicerParseResult, rawLine: string, flavor: GcodeFlavor) {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    const line = trimmed.replace(/^;+\s*/, "");
    const lower = line.toLowerCase();
    const parseValueAfterSeparator = () => {
      const eq = line.indexOf("=");
      if (eq >= 0) return line.slice(eq + 1).trim();
      const colon = line.indexOf(":");
      if (colon >= 0) return line.slice(colon + 1).trim();
      return "";
    };

    const setTime = (value: string, mode: "seconds" | "hms" = "hms") => {
      if (out.slicer_print_time_minutes != null) return;
      const mins = this.normalizeDurationToMinutes(value, mode);
      if (mins != null && mins > 0) out.slicer_print_time_minutes = mins;
    };

    const setMillimeters = (value: string) => {
      if (out.slicer_filament_used_mm != null) return;
      const mm = this.parseMeasurementSeries(value, "millimeters");
      if (mm != null && mm > 0) out.slicer_filament_used_mm = Math.round(mm * 100) / 100;
    };

    const setGrams = (value: string) => {
      if (out.slicer_filament_used_grams != null) return;
      const g = this.parseMeasurementSeries(value, "grams");
      if (g != null && g > 0) out.slicer_filament_used_grams = Math.round(g * 100) / 100;
    };

    const setLayerHeight = (value: string) => {
      if (out.slicer_layer_height_mm != null) return;
      const mm = this.parseMeasurementSeries(value, "millimeters");
      if (mm != null && mm > 0) out.slicer_layer_height_mm = Math.round(mm * 1000) / 1000;
    };

    const setPercent = (value: string) => {
      if (out.slicer_infill_percent != null) return;
      const pct = this.parsePercentValue(value);
      if (pct != null) out.slicer_infill_percent = pct;
    };

    if (flavor === "cura" || flavor === "unknown") {
      if (/^;?\s*TIME\s*:\s*/i.test(line)) {
        setTime(line.replace(/^;?\s*TIME\s*:\s*/i, ""), "seconds");
      }
      if (/^;?\s*Filament used\s*:\s*/i.test(line)) {
        setMillimeters(line.replace(/^;?\s*Filament used\s*:\s*/i, ""));
      }
      if (/^;?\s*Layer height\s*:\s*/i.test(line)) {
        setLayerHeight(line.replace(/^;?\s*Layer height\s*:\s*/i, ""));
      }
    }

    if (flavor === "prusa" || flavor === "bambu" || flavor === "unknown") {
      if (/estimated[_ ]printing[_ ]time/i.test(lower) || /model printing time/i.test(lower) || /total estimated time/i.test(lower)) {
        setTime(parseValueAfterSeparator(), "hms");
      }
      if (/filament used \[g\]/i.test(lower) || /total filament (?:used|weight) \[g\]/i.test(lower) || /filament weight/i.test(lower)) {
        setGrams(parseValueAfterSeparator());
      }
      if (/filament used \[mm\]/i.test(lower) || /total filament (?:used|length) \[mm\]/i.test(lower) || /filament length/i.test(lower)) {
        setMillimeters(parseValueAfterSeparator());
      }
      if (/layer_height/i.test(lower)) {
        setLayerHeight(parseValueAfterSeparator());
      }
      if (/fill_density/i.test(lower) || /sparse_infill_density/i.test(lower)) {
        setPercent(parseValueAfterSeparator());
      }
    }

    if (flavor === "simplify3d" || flavor === "ideamaker" || flavor === "unknown") {
      if (/build time/i.test(lower) || /print time/i.test(lower)) {
        setTime(parseValueAfterSeparator(), "hms");
      }
      if (/filament weight/i.test(lower)) {
        setGrams(parseValueAfterSeparator());
      }
      if (/filament length/i.test(lower)) {
        setMillimeters(parseValueAfterSeparator());
      }
    }
  }

  private detectGcodeFlavor(text: string): GcodeFlavor {
    const head = text.slice(0, 32_768).toLowerCase();
    const tail = text.slice(-16_384).toLowerCase();
    const sample = `${head}\n${tail}`;

    if (/;time:\d+/.test(sample) || /;filament used:/.test(sample) || /;layer height:/.test(sample)) {
      return "cura";
    }
    if (/estimated_printing_time|model printing time|total estimated time|total filament weight \[g\]|total filament length \[mm\]|sparse_infill_density/.test(sample)) {
      return "bambu";
    }
    if (/build time|filament length|filament weight/.test(sample)) {
      return "simplify3d";
    }
    if (/print time|filament weight|filament length/.test(sample)) {
      return "ideamaker";
    }
    if (/estimated printing time|filament used \[mm\]|filament used \[g\]|fill_density|support_material|layer_height/.test(sample)) {
      return "prusa";
    }
    return "unknown";
  }

  private normalizeDurationToMinutes(input: string | number, source: "seconds" | "minutes" | "hms" = "hms"): number | undefined {
    if (typeof input === "number") {
      if (!Number.isFinite(input) || input <= 0) return undefined;
      if (source === "seconds") return Math.max(1, Math.round(input / 60));
      return Math.max(1, Math.round(input));
    }

    const raw = input.trim();
    if (!raw) return undefined;

    const clock = raw.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (clock) {
      const first = Number(clock[1]);
      const second = Number(clock[2]);
      const third = clock[3] != null ? Number(clock[3]) : undefined;
      if (third != null) {
        return Math.max(1, Math.round(first * 60 + second + third / 60));
      }
      return Math.max(1, Math.round(first + second / 60));
    }

    const component = (regex: RegExp) => {
      const match = raw.match(regex);
      return match?.[1] != null ? Number(match[1]) : 0;
    };

    const days = component(/(\d+(?:\.\d+)?)\s*d/i);
    const hours = component(/(\d+(?:\.\d+)?)\s*h/i);
    const minutes = component(/(\d+(?:\.\d+)?)\s*m(?!m)/i);
    const seconds = component(/(\d+(?:\.\d+)?)\s*s/i);
    const hasExplicitUnits = /[dhms]/i.test(raw);

    if (hasExplicitUnits) {
      const total = days * 24 * 60 + hours * 60 + minutes + seconds / 60;
      if (total > 0) return Math.max(1, Math.round(total));
    }

    const numeric = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(numeric) && numeric > 0) {
      if (source === "seconds") return Math.max(1, Math.round(numeric / 60));
      if (source === "minutes") return Math.max(1, Math.round(numeric));
    }

    return undefined;
  }

  private parseMeasurementSeries(input: string, kind: "millimeters" | "grams"): number | undefined {
    const tokens = input
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean);
    let total = 0;
    let found = false;

    for (const token of tokens.length > 0 ? tokens : [input]) {
      const parsed = this.parseSingleMeasurement(token, kind);
      if (parsed == null) continue;
      total += parsed;
      found = true;
    }

    if (!found) {
      return this.parseSingleMeasurement(input, kind);
    }

    return Math.round(total * 100) / 100;
  }

  private parseSingleMeasurement(input: string, kind: "millimeters" | "grams"): number | undefined {
    const raw = input.trim();
    if (!raw) return undefined;
    const match = raw.match(/(-?\d+(?:\.\d+)?)(?:\s*([a-z%]+))?/i);
    if (!match) return undefined;

    const value = Number(match[1]);
    if (!Number.isFinite(value)) return undefined;

    const unit = (match[2] ?? "").toLowerCase();
    if (kind === "millimeters") {
      if (unit === "cm") return value * 10;
      if (unit === "m") return value * 1000;
      if (unit === "um" || unit === "µm") return value / 1000;
      return value;
    }

    if (unit === "kg") return value * 1000;
    if (unit === "mg") return value / 1000;
    return value;
  }

  private parsePercentValue(input: string): number | undefined {
    const raw = input.trim();
    if (!raw) return undefined;
    const match = raw.match(/(-?\d+(?:\.\d+)?)/);
    if (!match) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return undefined;
    if (raw.includes("%")) return Math.max(0, Math.min(100, Math.round(value)));
    if (value <= 1 && value >= 0) return Math.max(0, Math.min(100, Math.round(value * 100)));
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private isBgcode(buffer: Buffer): boolean {
    if (buffer.length < 4) return false;
    const magic = buffer.subarray(0, 4).toString("latin1");
    return magic === "GCDE" || magic === "gcod";
  }

  private isZipBuffer(buffer: Buffer): boolean {
    if (buffer.length < 4) return false;
    return buffer[0] === 0x50 && buffer[1] === 0x4b && (
      (buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08)
    );
  }

  private readUInt32LEIfPlausible(buffer: Buffer, offset: number, min: number, max: number): number | null {
    if (offset + 4 > buffer.length) return null;
    const value = buffer.readUInt32LE(offset);
    if (value < min || value > max) return null;
    return value;
  }

  private readFloatLEIfPlausible(buffer: Buffer, offset: number, min: number, max: number): number | null {
    if (offset + 4 > buffer.length) return null;
    const value = buffer.readFloatLE(offset);
    if (!Number.isFinite(value) || value < min || value > max) return null;
    return value;
  }

  // ── Minimal ZIP reader (for .3mf / .zip slicer bundles) ──────────────────
  // .3mf is just a ZIP container. We avoid a runtime dependency by walking the
  // central directory ourselves and inflating only the small config + (if
  // needed) one embedded g-code entry. Handles store (0) + deflate (8).

  /** Pull text out of the archive entries most likely to hold the summary. */
  private async extractArchiveText(buffer: Buffer): Promise<string> {
    const entries = this.readZipCentralDirectory(buffer);
    let collected = "";

    for (const e of entries) {
      const name = e.name.toLowerCase();
      if (
        name.endsWith(".config") ||
        name.endsWith(".xml") ||
        name.endsWith(".ini") ||
        name.endsWith(".json") ||
        name.includes("slice_info") ||
        name.includes("metadata")
      ) {
        const t = await this.readZipEntryText(buffer, e, 256 * 1024);
        if (t) collected += "\n" + t;
      }
    }

    if (!/printing time|estimated time|prediction|filament|weight|used_g/i.test(collected)) {
      for (const e of entries) {
        const name = e.name.toLowerCase();
        if ((name.endsWith(".gcode") || name.endsWith(".gco")) && e.compSize < 16 * 1024 * 1024) {
          const t = await this.readZipEntryText(buffer, e, 256 * 1024);
          if (t) {
            collected += "\n" + t;
            break;
          }
        }
      }
    }

    return collected;
  }

  /** Walk the ZIP central directory → list of entries. Empty on any anomaly. */
  private readZipCentralDirectory(
    buf: Buffer
  ): Array<{ name: string; method: number; compSize: number; localOffset: number }> {
    const out: Array<{ name: string; method: number; compSize: number; localOffset: number }> = [];
    let eocd = -1;
    const minPos = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= minPos; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return out;

    const total = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < total; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString("latin1");
      out.push({ name, method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /** Inflate one entry and return up to maxBytes from its head + tail. */
  private async readZipEntryText(
    buf: Buffer,
    e: { method: number; compSize: number; localOffset: number },
    maxBytes: number
  ): Promise<string> {
    const lh = e.localOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) return "";
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataStart, dataStart + e.compSize);
    let raw: Buffer;
    if (e.method === 0) {
      raw = comp.subarray(0, MAX_INFLATED_BYTES);
    } else if (e.method === 8) {
      try {
        raw = (await inflateRaw(comp, { maxOutputLength: MAX_INFLATED_BYTES })) as Buffer;
      } catch {
        return "";
      }
    } else {
      return "";
    }
    if (raw.length <= maxBytes * 2) return raw.toString("latin1");
    return (
      raw.subarray(0, maxBytes).toString("latin1") +
      "\n" +
      raw.subarray(raw.length - maxBytes).toString("latin1")
    );
  }

  private async readGcodeWindowText(filePath: string): Promise<string> {
    const [head, tail] = await Promise.all([
      this.readHeadLines(filePath, TEXT_GCODE_HEAD_LINES),
      this.readTailLines(filePath, TEXT_GCODE_TAIL_LINES)
    ]);
    const merged = this.dedupePreserve([...head, ...tail]);
    return merged.join("\n");
  }

  private async readHeadLines(filePath: string, limit: number): Promise<string[]> {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const chunkSize = 64 * 1024;
      let cursor = 0;
      let carry = "";
      const lines: string[] = [];

      while (cursor < stat.size && lines.length < limit) {
        const size = Math.min(chunkSize, stat.size - cursor);
        const buf = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buf, 0, size, cursor);
        if (!bytesRead) break;
        cursor += bytesRead;
        carry += buf.subarray(0, bytesRead).toString("latin1");
        const parts = carry.split(/\r?\n/);
        carry = parts.pop() ?? "";
        lines.push(...parts);
      }

      if (carry) lines.push(carry);
      return lines.slice(0, limit);
    } finally {
      await handle.close();
    }
  }

  private async readTailLines(filePath: string, limit: number): Promise<string[]> {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const chunkSize = 64 * 1024;
      let remaining = stat.size;
      let carry = "";
      let lines: string[] = [];

      while (remaining > 0 && lines.length < limit) {
        const size = Math.min(chunkSize, remaining);
        remaining -= size;
        const buf = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buf, 0, size, remaining);
        if (!bytesRead) break;
        carry = buf.subarray(0, bytesRead).toString("latin1") + carry;
        lines = carry.split(/\r?\n/);
      }

      return lines.slice(-limit);
    } finally {
      await handle.close();
    }
  }

  private dedupePreserve(lines: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  }
}
