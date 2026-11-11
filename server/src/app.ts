import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { createCognitoVerifier, registerAuth, type TokenVerifier } from './auth.js';
import type { Config } from './config.js';
import type { DbChecker } from './db/client.js';
import { ExternalApiError } from './adapters/http.js';
import { AppError, errorBody, externalServiceError, type ErrorCode } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/session.js';

/** クライアント指定の x-request-id は、ログ・応答ヘッダーに安全な形式のみ受け付ける */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const VALIDATION_ERROR = {
  code: 'VALIDATION_ERROR',
  message: '入力内容を確認してください',
} as const;
const NOT_FOUND = { code: 'NOT_FOUND', message: '対象が見つかりません' } as const;
/**
 * Fastify が投げる 4xx（不正JSON・サイズ超過・Content-Type 不一致等）を共通形式に変換する。
 * ここにない 4xx は VALIDATION_ERROR にする
 */
const CLIENT_ERRORS: Record<number, { code: ErrorCode; message: string }> = {
  401: { code: 'UNAUTHORIZED', message: '認証が必要です' },
  403: { code: 'FORBIDDEN', message: 'この操作は許可されていません' },
  404: NOT_FOUND,
  409: { code: 'CONFLICT', message: '現在の状態では実行できません' },
  429: { code: 'RATE_LIMITED', message: 'しばらく時間をおいて再度お試しください' },
};

/** Ajv の instancePath（例 "/stations/0"）と missingProperty を "stations.0.name" 形式にそろえる */
function toField(instancePath: string, params: Record<string, unknown> | undefined): string {
  const path = instancePath.replace(/^\//, '').replace(/\//g, '.');
  const missing = params?.missingProperty;
  if (typeof missing === 'string') return path ? `${path}.${missing}` : missing;
  return path;
}

/**
 * ログの設定。要求ログの URL はパスだけにする（住所サジェストの q、OAuth の code・state などを残さない）。
 * 認証情報も出さない（既定の要求ログはヘッダーを出さないが、出力項目を増やしたときの保険）。
 */
export const loggerOptions = (level: string) => ({
  level,
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  serializers: {
    req: (req: { method: string; url: string }) => ({
      method: req.method,
      url: req.url.split('?')[0],
    }),
  },
});

export interface BuildAppOptions {
  config: Config;
  db?: DbChecker;
  /** テスト用。指定しない場合は config の Cognito の設定から作る */
  verifier?: TokenVerifier;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({
  config,
  db,
  verifier,
  logger,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? loggerOptions(config.LOG_LEVEL),
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Fastify 5 では error が unknown になるため、型引数で FastifyError を指定する
  app.setErrorHandler<FastifyError | AppError | ExternalApiError>((thrown, request, reply) => {
    let error = thrown;
    if (error instanceof ExternalApiError) {
      // どの外部 API がどう失敗したかはログだけに残し、利用者には共通の文言を返す
      request.log.warn(
        {
          service: error.service,
          operation: error.operation,
          kind: error.kind,
          status: error.status,
          detail: error.message,
        },
        'external api failed',
      );
      error = externalServiceError();
    }
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send(errorBody(error.code, error.message, request.id, error.details));
    }
    if ('validation' in error && error.validation) {
      const details = error.validation.map((v) => ({
        field: toField(v.instancePath, v.params),
        message: v.message ?? '不正な値です',
      }));
      return reply
        .code(400)
        .send(errorBody(VALIDATION_ERROR.code, VALIDATION_ERROR.message, request.id, details));
    }
    const status = error.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const { code, message } = CLIENT_ERRORS[status] ?? VALIDATION_ERROR;
      request.log.info({ statusCode: status, code: error.code }, 'client error');
      return reply.code(status).send(errorBody(code, message, request.id));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send(
        errorBody(
          'INTERNAL_ERROR',
          'エラーが発生しました。時間をおいて再度お試しください',
          request.id,
        ),
      );
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody(NOT_FOUND.code, NOT_FOUND.message, request.id)),
  );

  registerAuth(
    app,
    verifier ??
      (config.COGNITO_USER_POOL_ID && config.COGNITO_WEB_CLIENT_ID
        ? createCognitoVerifier(config.COGNITO_USER_POOL_ID, config.COGNITO_WEB_CLIENT_ID)
        : undefined),
  );

  // /api（APIサービス）と /agent（AI連携基盤）のルートを登録する（認証は registerAuth が既定で掛ける）
  await app.register(healthRoutes, { version: config.APP_VERSION, db });
  await app.register(sessionRoutes);

  return app;
}
