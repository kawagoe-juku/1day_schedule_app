/** OpenAPI（api/openapi.yaml）の Error.code と一致させる */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'FEATURE_DISABLED'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field: string;
  message: string;
}

/** 業務エラー。ルートで throw するとエラーハンドラが共通形式に変換する。 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
  };
}

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
): ErrorBody {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } };
}
