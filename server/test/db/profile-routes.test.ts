import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoogleMapsClient } from '../../src/adapters/google-maps.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { userRepository } from '../../src/db/repositories/user-repository.js';
import { AUTH, TEST_EMAIL, TEST_USER_ID, fakeCognito, fakeVerifier } from '../helpers/route-app.js';
import { useTestDb } from '../helpers/test-db.js';

const config = loadConfig({ NODE_ENV: 'test' });
const HOME = { lat: 35.681236, lng: 139.767125 };

describe('プロファイルの API（実際の DB に保存する）', () => {
  const { db } = useTestDb();
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const setup = async () => {
    app = await buildApp({
      config,
      verifier: fakeVerifier,
      users: userRepository(db()),
      cognito: fakeCognito().client,
      external: {
        googleMaps: {
          async getPlace(placeId: string) {
            return { placeId, name: '自宅', location: HOME };
          },
        } as unknown as GoogleMapsClient,
      },
      logger: false,
    });
    return app;
  };

  it('初回の取得で既定値の行を作り、オンボーディングの完了を保存できる（IT-019：Cognito の利用者 ID とプロファイルの紐付け）', async () => {
    const server = await setup();
    const first = await server.inject({ method: 'GET', url: '/api/profile', headers: AUTH });
    expect(first.json()).toMatchObject({ email: TEST_EMAIL, onboardingCompleted: false });
    expect(await userRepository(db()).findById(TEST_USER_ID)).toMatchObject({ id: TEST_USER_ID });

    const saved = await server.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: AUTH,
      payload: {
        homeAddress: '東京都千代田区丸の内1丁目',
        homePlaceId: 'place-tokyo',
        frequentStations: [
          { stationCode: '00007820', stationName: '吉祥寺' },
          { stationName: '渋谷' },
        ],
        walkingSpeed: 'fast',
        preparationTimeMinutes: 20,
        priorityCondition: 'save_money',
        acceptTerms: true,
        completeOnboarding: true,
      },
    });
    expect(saved.statusCode).toBe(200);

    const row = await userRepository(db()).findById(TEST_USER_ID);
    expect(row).toMatchObject({
      homeAddress: '東京都千代田区丸の内1丁目',
      homeLatitude: HOME.lat,
      homeLongitude: HOME.lng,
      frequentlyUsedStations: [
        { stationCode: '00007820', stationName: '吉祥寺' },
        { stationName: '渋谷' },
      ],
      walkingSpeed: 'fast',
      preparationTimeMinutes: 20,
      priorityCondition: 'save_money',
      onboardingCompleted: true,
    });
    expect(row?.termsAcceptedAt).toBeInstanceOf(Date);

    const again = await server.inject({ method: 'GET', url: '/api/profile', headers: AUTH });
    expect(again.json()).toEqual(saved.json());
  });

  it('利用者ごとに別の行になる', async () => {
    const server = await setup();
    await server.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: AUTH,
      payload: { walkingSpeed: 'slow' },
    });
    const other = await server.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { authorization: 'Bearer token-other-user' },
    });
    expect(other.json().walkingSpeed).toBe('normal');
    expect((await userRepository(db()).findById(TEST_USER_ID))?.walkingSpeed).toBe('slow');
  });
});
