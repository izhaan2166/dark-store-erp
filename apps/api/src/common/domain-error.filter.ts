import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { DomainError } from "./errors";

/** Turns business rule failures into stable JSON error responses. */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(error.httpStatus).json({
      error: { code: error.code, message: error.message, details: error.details ?? null },
    });
  }
}
