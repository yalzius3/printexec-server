import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Catch, Logger, type ArgumentsHost, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication
} from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";

// Log the stack for any non-HTTP (i.e. unexpected 500) exception so "Internal
// server error" responses are diagnosable instead of opaque.
@Catch()
class LoggingExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger("UnhandledError");
  catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<{ method?: string; url?: string }>();
    if (!(exception instanceof HttpException)) {
      this.logger.error(`500 on ${req?.method} ${req?.url}: ${(exception as Error)?.message}`, (exception as Error)?.stack);
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
