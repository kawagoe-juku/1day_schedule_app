import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Config } from './config.js';
import type { DbChecker } from './db.js';
import { AppError, errorBody, type ErrorCode } from './errors.js';
import { healthRoutes } from './routes/health.js';

/** クライアント指定の x-request-id は、ログ・応答ヘッダーに安全な形式のみ受け付ける */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Fastify が投げる 4xx（不正JSON・サイズ超過・Content-Type 不一致等）を共通形式に変換する */
const CLIENT_ERRORS: Record<number, { code: ErrorCode; message: string }> = {
  401: { code: 'UNAUTHORIZED', message: '認証が必要です' },
  403: { code: 'FORBIDDEN', message: 'この操作は許可されていません' },
  404: { code: 'NOT_FOUND', message: '対象が見つかりません' },
  409: { code: 'CONFLICT', message: '現在の状態では実行できません' },
  429: { code: 'RATE_LIMITED', message: 'しばらく時間をおいて再度お試しください' },
};
const DEFAULT_CLIENT_ERROR = {
  code: 'VALIDATION_ERROR',
  message: '入力内容を確認してください',
} as const;

/** Ajv の instancePath（例 "/stations/0"）と missingProperty を "stations.0.name" 形式にそろえる */
function toField(instancePath: string, params: Record<string, unknown> | undefined): string {
  const path = instancePath.replace(/^\//, '').replace(/\//g, '.');
  const missing = params?.missingProperty;
  if (typeof missing === 'string') return path ? `${path}.${missing}` : missing;
  return path;
}

export interface BuildAppOptions {
  config: Config;
  db?: DbChecker;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({ config, db, logger }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? {
      level: config.LOG_LEVEL,
      // 認証情報をログに出さない
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Fastify 5 では error が unknown になるため、型引数で FastifyError を指定する
  app.setErrorHandler<FastifyError | AppError>((error, request, reply) => {
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
        .send(errorBody('VALIDATION_ERROR', '入力内容を確認してください', request.id, details));
    }
    const status = error.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const { code, message } = CLIENT_ERRORS[status] ?? DEFAULT_CLIENT_ERROR;
      request.log.info({ err: error }, 'client error');
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
    reply.code(404).send(errorBody('NOT_FOUND', '対象が見つかりません', request.id)),
  );

  await app.register(healthRoutes, { version: config.APP_VERSION, db });

  return app;
}
