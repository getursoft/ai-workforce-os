import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { AppModule } from "./app.module";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "./identity/infrastructure/security/security-config";
import { ApiExceptionFilter } from "./identity/presentation/http/api-exception.filter";

loadEnvFile(resolve(__dirname, "../../../.env"));

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const securityConfig = app.get<SecurityConfig>(SECURITY_CONFIG);
  app.enableCors({
    origin: securityConfig.webAppUrl,
    credentials: true,
    exposedHeaders: ["x-request-id"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false
    })
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle("AI Workforce OS API").setVersion("1.0").addBearerAuth().build()
  );
  SwaggerModule.setup("docs", app, document, { useGlobalPrefix: true });
  await app.listen(4000, "0.0.0.0");
}

void bootstrap();
