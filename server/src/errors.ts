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

/** 認証の失敗。理由（期限切れ・署名不正など）は利用者に返さない */
export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', '認証が必要です');

/** 準備のみの機能（Feature Flag が OFF）。API 仕様の 501 FEATURE_DISABLED */
export const featureDisabled = () =>
  new AppError(501, 'FEATURE_DISABLED', 'この機能は現在ご利用いただけません');

/** 外部サービス（Google Maps・乗換案内など）の失敗。API 仕様の 502 EXTERNAL_SERVICE_ERROR */
export const externalServiceError = () =>
  new AppError(
    502,
    'EXTERNAL_SERVICE_ERROR',
    '外部サービスに接続できませんでした。時間をおいて再度お試しください',
  );

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
