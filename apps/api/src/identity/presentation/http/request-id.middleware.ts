import { Injectable, type NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { IdentityRequest, IdentityResponse } from "./request-context";

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: IdentityRequest, response: IdentityResponse, next: () => void): void {
    const incoming = request.header("x-request-id");
    request.requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    response.setHeader("x-request-id", request.requestId);
    next();
  }
}
