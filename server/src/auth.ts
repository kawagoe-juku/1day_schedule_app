import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { FastifyInstance } from 'fastify';
import { unauthorized } from './errors.js';

/** 検証を通ったトークンの利用者 */
export interface AuthUser {
  /** Cognito の利用者 ID（JWT の sub） */
  sub: string;
  /** トークンの有効期限（UNIX 秒） */
  exp: number;
}

/** トークンを検証し、利用者を返す。不正なら例外を投げる */
export interface TokenVerifier {
  verify(token: string): Promise<AuthUser>;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyContextConfig {
    /** true のルートは認証しない（ヘルスチェック・OAuth のコールバック） */
    public?: boolean;
  }
}

class JwtMissingExpError extends Error {}

/**
 * Cognito のアクセストークンを検証する。署名（公開鍵は Cognito から取得してキャッシュ）・期限・
 * 発行元（User Pool）・token_use=access・client_id（Web 用クライアント）を確かめる。
 */
export function createCognitoVerifier(
  userPoolId: string,
  clientId: string,
  /** テスト用。公開鍵を渡すと Cognito から取得せずにこれを使う */
  jwks?: Parameters<ReturnType<typeof CognitoJwtVerifier.create>['cacheJwks']>[0],
): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' });
  if (jwks) verifier.cacheJwks(jwks);
  return {
    async verify(token) {
      const payload = await verifier.verify(token);
      // Cognito は必ず exp を付けるが、無いトークンは受け付けない
      if (typeof payload.exp !== 'number') throw new JwtMissingExpError();
      return { sub: payload.sub, exp: payload.exp };
    },
  };
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;
/** トークン自体の不正を表す例外（JwtExpiredError・CognitoJwtInvalidClientIdError など） */
const TOKEN_FAULT = /^(Cognito)?Jwt/;

/**
 * すべてのルートに認証を掛ける（付け忘れを防ぐため既定で必須）。認証しないルートは config.public で外す。
 * 存在しないパスは認証せず 404 にする。失敗の理由は利用者に返さず、ログだけに残す。
 */
export function registerAuth(app: FastifyInstance, verifier: TokenVerifier | undefined): void {
  if (!verifier) {
    app.log.warn('COGNITO_* が未設定のため、認証が必要な API はすべて 401 になります');
  }
  app.addHook('onRequest', async (request) => {
    if (request.is404 || request.routeOptions.config.public) return;
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token || !verifier) {
      request.log.info({ reason: token ? 'verifier not configured' : 'no token' }, 'unauthorized');
      throw unauthorized();
    }
    try {
      request.user = await verifier.verify(token);
    } catch (err) {
      // aws-jwt-verify の例外はクラス名で種類が分かる（name は設定されないことがある）
      const reason = err instanceof Error ? err.constructor.name : 'unknown';
      if (TOKEN_FAULT.test(reason)) {
        // トークン自体の不正（期限切れ・署名不正・別クライアントなど）は利用者側の問題。
        // 例外にはトークンの中身（rawJwt）が付くため、ログには種類だけを残す
        request.log.info({ reason }, 'unauthorized');
      } else {
        // 公開鍵を取得できない（通信障害など）は運用で気づけるよう warn にする。応答は 401 のまま
        request.log.warn({ err }, 'token verification unavailable');
      }
      throw unauthorized();
    }
  });
}
