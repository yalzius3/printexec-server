import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Catch, Logger, type ArgumentsHost, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication
} from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";

// A raw Postgres failure reaches the browser as "Internal server error" and
// nothing else. The cause is in the server log, so anyone WITHOUT log access —
// an operator, or someone debugging a deployed environment remotely — has no
// way to tell a missing migration from a genuine bug. Every resin failure in
// this subsystem cost a round-trip for exactly that reason.
//
// These are the failure modes that are about the SHAPE of the database rather
// than the request, and each has an obvious next action, so say it.
type PgError = {
  code?: string;
  column?: string;
  constraint?: string;
  table?: string;
  message?: string;
};
const isPgError = (e: unknown): e is PgError =>
  !!e && typeof e === "object" && typeof (e as PgError).code === "string";

/** Postgres SQLSTATE → (http status, actionable message). Schema names only —
 *  never row values, which could carry customer data. */
function describePgError(e: PgError): { status: number; message: string } | null {
  switch (e.code) {
    case "42703": // undefined_column
      return {
        // 503, not 400: the request was fine, the deployment is incomplete.
        status: 503,
        message:
          `The database is missing a column this feature needs${e.column ? ` ("${e.column}")` : ""}. ` +
          `A migration in printexec-server/migrations/ has not been applied to this database yet.`,
      };
    case "42P01": // undefined_table
      return {
        status: 503,
        message:
          `The database is missing a table this feature needs${e.table ? ` ("${e.table}")` : ""}. ` +
          `A migration in printexec-server/migrations/ has not been applied to this database yet.`,
      };
    case "23514": // check_violation
      return {
        status: 409,
        message:
          `The database rejected this change: it violates ${e.constraint ? `"${e.constraint}"` : "a check constraint"}. ` +
          `The record is missing something that status or state requires.`,
      };
    case "23503": // foreign_key_violation
      return {
        status: 409,
        message: `This references a record that does not exist${e.constraint ? ` (${e.constraint})` : ""}.`,
      };
    case "23502": // not_null_violation
      return {
        status: 409,
        message: `A required field was empty${e.column ? ` ("${e.column}")` : ""}.`,
      };
    default:
      return null;
  }
}

// Log the stack for any non-HTTP (i.e. unexpected 500) exception so "Internal
// server error" responses are diagnosable instead of opaque.
@Catch()
class LoggingExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger("UnhandledError");
  catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<{ method?: string; url?: string }>();
    if (!(exception instanceof HttpException)) {
      this.logger.error(`500 on ${req?.method} ${req?.url}: ${(exception as Error)?.message}`, (exception as Error)?.stack);
      // Re-throw as a described HttpException so the browser gets the reason,
      // not just the fact. The full stack is already logged above.
      if (isPgError(exception)) {
        const described = describePgError(exception);
        if (described) {
          this.logger.error(`  ↳ pg ${exception.code}: ${described.message}`);
          return super.catch(
            new HttpException(described.message, described.status),
            host
          );
        }
      }
    } else if (exception.getStatus() >= 400) {
      // Log client errors too (temporarily) so opaque "loads then fails" UI
      // failures are diagnosable — includes the human message.
      this.logger.warn(`${exception.getStatus()} on ${req?.method} ${req?.url}: ${JSON.stringify(exception.getResponse())}`);
    }
    super.catch(exception, host);
  }
}

// 96 MB ceiling. All production traffic reaches this API through the
// Cloudflare Pages proxy, whose request-body cap (~100 MB) silently kills
// anything larger at the edge — the old 250 MB server limit was unreachable
// and just produced opaque edge errors. The client pre-checks the same 96 MB
// (MAX_UPLOAD_BYTES in App.tsx) so users get a clear message before sending.
const UPLOAD_BYTES_LIMIT = 96 * 1024 * 1024;

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: UPLOAD_BYTES_LIMIT,
      // Legacy upload URLs were persisted as "/uploads/<company>/<file>" (no
      // "/api" prefix) back when @fastify/static served them. Those mounts are
      // gone — uploads are now served by the guarded UploadsController under
      // "/api/uploads/...". Reroute the legacy path to the canonical one before
      // routing so every previously-stored URL keeps resolving.
      rewriteUrl: (req: import("http").IncomingMessage) => {
        const url = req.url ?? "/";
        return url === "/uploads" || url.startsWith("/uploads/") ? `/api${url}` : url;
      }
    })
  );

  // Register fastify-multipart for the upload POST handler. (The former
  // @fastify/static mounts were removed: they bypassed SupabaseAuthGuard, so
  // any party could read any company's files by guessing a URL. Serving now
  // goes through the guarded UploadsController.)
  await app.register(require("@fastify/multipart"), {
    limits: {
      fileSize: UPLOAD_BYTES_LIMIT,
      files: 1
    },
    throwFileSizeLimit: true
  });

  // Gzip/Brotli every compressible response (JSON list payloads especially).
  // @fastify/compress gates on mime-db's `compressible` flag, so binary file
  // downloads (image/*, application/octet-stream g-code/STL) are skipped
  // automatically — only text/JSON is compressed. threshold avoids the CPU cost
  // on tiny bodies where a header+dictionary would outweigh the savings.
  await app.register(require("@fastify/compress"), {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip", "deflate"]
  });

  app.enableCors({
    origin: process.env.ALLOWED_ORIGIN || 'http://localhost:5173',
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization'
  });

  app.setGlobalPrefix("api");
  app.useGlobalFilters(new LoggingExceptionFilter(app.getHttpAdapter()));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
