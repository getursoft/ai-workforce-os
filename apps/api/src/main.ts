import {
  Logger,
  RequestMethod,
  ValidationPipe
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  DocumentBuilder,
  SwaggerModule
} from "@nestjs/swagger";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { AppModule } from "./app.module";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "./identity/infrastructure/security/security-config";
import { ApiExceptionFilter } from "./identity/presentation/http/api-exception.filter";

/**
 * Loads environment variables from:
 *
 * 1. Repository root:
 *    ai-workforce-os/.env
 *
 * 2. API-specific environment file:
 *    ai-workforce-os/apps/api/.env
 *
 * Existing shell environment variables remain available.
 */
function loadEnvironmentFiles(): void {
  const rootEnvPath = resolve(__dirname, "../../../.env");
  const apiEnvPath = resolve(__dirname, "../.env");

  if (existsSync(rootEnvPath)) {
    loadEnvFile(rootEnvPath);
  }

  if (existsSync(apiEnvPath)) {
    loadEnvFile(apiEnvPath);
  }
}

loadEnvironmentFiles();

/**
 * Resolves the running build identifier so a stale deployment is immediately
 * visible in startup logs.
 *
 * It first checks common CI/CD environment variables. For local development,
 * it falls back to the current Git commit.
 */
function resolveBuildIdentifier(): string {
  const fromEnvironment =
    process.env.GIT_COMMIT ??
    process.env.BUILD_SHA ??
    process.env.SOURCE_VERSION ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.HEROKU_SLUG_COMMIT;

  if (fromEnvironment) {
    return fromEnvironment;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(__dirname, "../../.."),
      encoding: "utf8",
      timeout: 2_000
    }).trim();
  } catch {
    return "unknown";
  }
}

async function bootstrap(): Promise<void> {
  const logger = new Logger("Bootstrap");

  logger.log({
    event: "API_STARTUP",
    buildCommit: resolveBuildIdentifier(),
    nodeEnv: process.env.NODE_ENV ?? "unknown"
  });

  /*
   * Safe temporary Sarvam configuration check.
   *
   * This confirms that the key was loaded without printing the actual key.
   * Remove this block after successful verification.
   */

  const app = await NestFactory.create(AppModule);

  const securityConfig =
    app.get<SecurityConfig>(SECURITY_CONFIG);

  const httpServer = app
    .getHttpAdapter()
    .getInstance() as {
      disable(setting: string): void;
    };

  httpServer.disable("x-powered-by");

  app.enableShutdownHooks();

  app.use(
    (
      _request: unknown,
      response: {
        setHeader(name: string, value: string): void;
      },
      next: () => void
    ) => {
      response.setHeader(
        "X-Content-Type-Options",
        "nosniff"
      );

      response.setHeader(
        "Referrer-Policy",
        "no-referrer"
      );

      response.setHeader(
        "X-Frame-Options",
        "DENY"
      );

      response.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      );

      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
      );

      if (
        securityConfig.nodeEnvironment === "production"
      ) {
        response.setHeader(
          "Strict-Transport-Security",
          "max-age=31536000; includeSubDomains"
        );
      }

      next();
    }
  );

  app.enableCors({
    origin: securityConfig.webAppUrl,
    credentials: true,
    exposedHeaders: ["x-request-id"],
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ]
  });

  app.setGlobalPrefix("api/v1", {
    exclude: [
      {
        path: "health/live",
        method: RequestMethod.GET
      },
      {
        path: "health/ready",
        method: RequestMethod.GET
      }
    ]
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false
    })
  );

  app.useGlobalFilters(
    new ApiExceptionFilter()
  );

  const swaggerConfiguration =
    new DocumentBuilder()
      .setTitle("AI Workforce OS API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();

  const swaggerDocument =
    SwaggerModule.createDocument(
      app,
      swaggerConfiguration
    );

  SwaggerModule.setup(
    "docs",
    app,
    swaggerDocument,
    {
      useGlobalPrefix: true
    }
  );

  await app.listen(
    securityConfig.serverPort,
    "0.0.0.0"
  );

  logger.log({
    event: "API_READY",
    port: securityConfig.serverPort,
    environment: securityConfig.nodeEnvironment
  });
}

void bootstrap();