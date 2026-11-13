/**
 * Cognito から利用者の情報を取得するクライアント。
 * メールアドレスは DB に持たず（DB 定義の判断事項 D3）、API が受け取るアクセストークンにも
 * 含まれないため、必要なときに Cognito の GetUser で取得する。
 * GetUser は利用者本人のアクセストークンで呼ぶ API で、AWS の認証情報（IAM）は要らない。
 */
import { z } from 'zod';
import { requestJson, type HttpOptions } from './http.js';

const SERVICE = 'cognito';
/** 取得したメールアドレスを覚えておく時間。メールアドレスの変更は、この時間だけ遅れて反映される */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** 覚えておく人数の上限。超えたら全部捨てる（メモリを使い続けないため） */
const CACHE_MAX_ENTRIES = 10_000;

export interface CognitoUserClientOptions extends HttpOptions {
  /** User Pool の ID（例：ap-northeast-1_xxxxxxxxx）。先頭がリージョン */
  userPoolId: string;
  /** テスト用。現在時刻（ミリ秒） */
  now?: () => number;
}

export interface CognitoUserClient {
  /**
   * 利用者のメールアドレスを返す。
   * userId（JWT の sub）は覚えておくためのキーで、Cognito への問い合わせにはアクセストークンを使う。
   */
  getEmail(userId: string, accessToken: string): Promise<string>;
}

const GetUserResponse = z.object({
  UserAttributes: z.array(z.object({ Name: z.string(), Value: z.string() })),
});

export function createCognitoUserClient(options: CognitoUserClientOptions): CognitoUserClient {
  const { userPoolId, now = Date.now, ...http } = options;
  const region = userPoolId.split('_')[0];
  const url = `https://cognito-idp.${region}.amazonaws.com/`;
  const cache = new Map<string, { email: string; expiresAt: number }>();

  return {
    async getEmail(userId, accessToken) {
      const cached = cache.get(userId);
      if (cached && cached.expiresAt > now()) return cached.email;

      const res = await requestJson(
        {
          service: SERVICE,
          operation: 'get_user',
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/x-amz-json-1.1',
            'x-amz-target': 'AWSCognitoIdentityProviderService.GetUser',
          },
          body: { AccessToken: accessToken },
          schema: GetUserResponse,
        },
        http,
      );
      const email = res.UserAttributes.find((a) => a.Name === 'email')?.Value;
      if (!email) {
        // メールアドレスでサインアップする設定なので、通常は必ずある
        throw new Error('Cognito の利用者にメールアドレスがありません');
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cache.set(userId, { email, expiresAt: now() + CACHE_TTL_MS });
      return email;
    },
  };
}
