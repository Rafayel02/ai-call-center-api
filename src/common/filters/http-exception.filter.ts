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
    if (this.isFileTooLarge(exception)) {
      response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        message: 'Audio file must be 25 MB or smaller.',
      });
      return;
    }
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

  private isFileTooLarge(exception: unknown) {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      (exception as { code?: string }).code === 'LIMIT_FILE_SIZE'
    );
  }
}
