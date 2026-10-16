import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttp ? exception.getResponse() : null;
    const message =
      typeof body === 'string'
        ? body
        : body && typeof body === 'object' && 'message' in body
          ? (body as { message: string | string[] }).message
          : 'Something went wrong.';

    if (!isHttp || status >= 500) {
      this.logger.error(exception instanceof Error ? exception.message : 'Unhandled error');
    }

    response.status(status).json({
      statusCode: status,
      message,
    });
  }
}
