import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { ZodError } from "zod";

/** Do not emit SQL detail (which may contain private values) or provider payloads. */
@Catch()
export class SaasExceptionFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    let status = 500,
      message = "operation_failed",
      fields: unknown;
    if (error instanceof HttpException) {
      status = error.getStatus();
      message = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      message = "invalid_fields";
      fields = error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
    } else if (["23503", "23505", "40001", "40P01"].includes(error?.code)) {
      status = 409;
      message = "record_conflict_or_unavailable";
    }
    host
      .switchToHttp()
      .getResponse()
      .status(status)
      .json({ message, ...(fields ? { fields } : {}) });
  }
}
