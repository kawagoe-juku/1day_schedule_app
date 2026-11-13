/**
 * API（ルート）のテスト用の部品。DB・Cognito・外部 API につながずに buildApp を動かす。
 */
import type { TokenVerifier } from '../../src/auth.js';
import type { CognitoUserClient } from '../../src/adapters/cognito.js';
import type { User, UserUpdate } from '../../src/db/repositories/user-repository.js';
import type { ProfileStore } from '../../src/routes/profile.js';

export const TEST_USER_ID = 'user-123';
export const TEST_EMAIL = 'user@example.com';
/** 認証を通るリクエストヘッダー */
export const AUTH = { authorization: `Bearer token-${TEST_USER_ID}` };

/** `Bearer token-<利用者ID>` を、その利用者のトークンとして通す */
export const fakeVerifier: TokenVerifier = {
  async verify(token) {
    if (!token.startsWith('token-')) throw new Error('invalid token');
    return { sub: token.slice('token-'.length), exp: 1_800_000_000 };
  },
};

/** 決まったメールアドレスを返す。calls に呼ばれた内容が残る */
export function fakeCognito(email = TEST_EMAIL) {
  const calls: { userId: string; accessToken: string }[] = [];
  const client: CognitoUserClient = {
    async getEmail(userId, accessToken) {
      calls.push({ userId, accessToken });
      return email;
    },
  };
  return { client, calls };
}

/** メモリ上のプロファイルの保存先（既定値は DB の定義と同じ） */
export function memoryProfileStore() {
  const rows = new Map<string, User>();
  const store: ProfileStore = {
    async ensure(id) {
      const existing = rows.get(id);
      if (existing) return existing;
      const created: User = {
        id,
        homeAddress: null,
        homeLatitude: null,
        homeLongitude: null,
        frequentlyUsedStations: [],
        walkingSpeed: 'normal',
        preparationTimeMinutes: 30,
        priorityCondition: 'on_time',
        memoUsageConsent: false,
        locationUsageConsent: false,
        calendarUsageConsent: false,
        notificationEnabled: false,
        onboardingCompleted: false,
        termsAcceptedAt: null,
        createdAt: new Date('2026-11-01T00:00:00Z'),
        updatedAt: new Date('2026-11-01T00:00:00Z'),
      };
      rows.set(id, created);
      return created;
    },
    async update(id, values: UserUpdate) {
      const existing = rows.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...values } as User;
      rows.set(id, updated);
      return updated;
    },
  };
  return { store, rows };
}
