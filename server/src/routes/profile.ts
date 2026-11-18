import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CognitoUserClient } from '../adapters/cognito.js';
import type { GoogleMapsClient, LatLng } from '../adapters/google-maps.js';
import type { User, UserUpdate } from '../db/repositories/user-repository.js';
import { externalServiceError, unauthorized, validationError } from '../errors.js';
import { parseInput } from '../validation.js';
import { toJstIso } from './session.js';

/** プロファイルの保存先。実体は userRepository（テストではメモリ上の代用品に差し替える） */
export interface ProfileStore {
  /** 初回アクセス時に既定値で行を作る。すでにあれば何もしない。どちらの場合も現在の行を返す */
  ensure(id: string): Promise<User>;
  update(id: string, values: UserUpdate): Promise<User | undefined>;
}

export interface ProfileRouteOptions {
  /** DB が未設定の環境では undefined（プロファイルの API は 500 を返す） */
  users?: ProfileStore;
  /** Cognito が未設定の環境では undefined（そもそも認証を通らない） */
  cognito?: CognitoUserClient;
  /** Google Maps のキーが未設定の環境では undefined（住所の保存は 502 を返す） */
  googleMaps?: Pick<GoogleMapsClient, 'geocode' | 'getPlace'>;
  /** テスト用。現在時刻 */
  now?: () => Date;
}

export const MAX_FREQUENT_STATIONS = 20;

const isControlCharacter = (char: string) => {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
};

/** 制御文字（NUL など。PostgreSQL が受け付けず、保存時に失敗する）を含まない文字列 */
const text = () =>
  z.string().refine((value) => ![...value].some(isControlCharacter), {
    message: '使用できない文字が含まれています',
  });

const FrequentStation = z.strictObject({
  stationCode: text().trim().min(1).max(50).optional(),
  stationName: text().trim().min(1).max(100),
  label: text().trim().min(1).max(50).optional(),
});

/** API 仕様（api/openapi.yaml）の ProfileUpdate。知らない項目は受け付けない */
const ProfileUpdate = z.strictObject({
  homeAddress: text().trim().min(1).max(255).optional(),
  homePlaceId: text().min(1).max(512).optional(),
  frequentStations: z.array(FrequentStation).max(MAX_FREQUENT_STATIONS).optional(),
  walkingSpeed: z.enum(['slow', 'normal', 'fast']).optional(),
  preparationTimeMinutes: z.number().int().min(0).max(180).optional(),
  priorityCondition: z.enum(['on_time', 'save_money', 'points']).optional(),
  acceptTerms: z.boolean().optional(),
  completeOnboarding: z.boolean().optional(),
});
type ProfileUpdate = z.infer<typeof ProfileUpdate>;

/** DB の行を API 仕様の Profile にする */
function toProfile(row: User, email: string) {
  return {
    email,
    onboardingCompleted: row.onboardingCompleted,
    homeAddress: row.homeAddress,
    homeLocation:
      row.homeLatitude !== null && row.homeLongitude !== null
        ? { lat: row.homeLatitude, lng: row.homeLongitude }
        : null,
    frequentStations: row.frequentlyUsedStations,
    walkingSpeed: row.walkingSpeed,
    preparationTimeMinutes: row.preparationTimeMinutes,
    priorityCondition: row.priorityCondition,
    termsAcceptedAt: row.termsAcceptedAt
      ? toJstIso(Math.floor(row.termsAcceptedAt.getTime() / 1000))
      : null,
  };
}

/** オンボーディング完了時に必須の項目がそろっているか確かめる */
function assertOnboardingInput(body: ProfileUpdate): void {
  const details = [
    body.homeAddress === undefined && {
      field: 'homeAddress',
      message: '自宅住所を入力してください',
    },
    body.homePlaceId === undefined && {
      field: 'homePlaceId',
      message: '自宅住所は候補から選んでください',
    },
    body.acceptTerms !== true && { field: 'acceptTerms', message: '利用への同意が必要です' },
  ].filter((d) => d !== false);
  if (details.length > 0) throw validationError(details);
}

export async function profileRoutes(
  app: FastifyInstance,
  opts: ProfileRouteOptions,
): Promise<void> {
  const now = opts.now ?? (() => new Date());

  /** 保存先と Cognito がそろっていなければ、設定の不備として 500 にする */
  const dependencies = () => {
    if (!opts.users || !opts.cognito) {
      throw new Error('プロファイルの API に必要な設定（DATABASE_URL・COGNITO_*）がありません');
    }
    return { users: opts.users, cognito: opts.cognito };
  };

  /** 自宅の座標を求める。候補の ID があればそれを使い、無ければ住所の文字列から求める */
  const resolveHomeLocation = async (body: ProfileUpdate): Promise<LatLng> => {
    if (!opts.googleMaps) {
      app.log.warn('GOOGLE_MAPS_SERVER_KEY が未設定のため、住所の座標を取得できません');
      throw externalServiceError();
    }
    if (body.homePlaceId !== undefined) {
      const place = await opts.googleMaps.getPlace(body.homePlaceId);
      if (place?.location) return place.location;
      throw validationError([
        { field: 'homePlaceId', message: '住所を確認できませんでした。候補から選び直してください' },
      ]);
    }
    // ここに来るのは homeAddress だけを指定したとき
    const geocoded = await opts.googleMaps.geocode(body.homeAddress ?? '');
    if (geocoded) return geocoded.location;
    throw validationError([
      { field: 'homeAddress', message: '住所を確認できませんでした。入力内容を確認してください' },
    ]);
  };

  app.get('/api/profile', async (request) => {
    if (!request.user || !request.accessToken) throw unauthorized();
    const { users, cognito } = dependencies();
    const email = await cognito.getEmail(request.user.sub, request.accessToken);
    return toProfile(await users.ensure(request.user.sub), email);
  });

  app.put('/api/profile', async (request) => {
    if (!request.user || !request.accessToken) throw unauthorized();
    const { users, cognito } = dependencies();
    const body = parseInput(ProfileUpdate, request.body);
    if (body.completeOnboarding === true) assertOnboardingInput(body);
    if (body.homePlaceId !== undefined && body.homeAddress === undefined) {
      // 候補の ID だけでは、画面に出す住所の文字列が決まらない
      throw validationError([{ field: 'homeAddress', message: '自宅住所を入力してください' }]);
    }

    const email = await cognito.getEmail(request.user.sub, request.accessToken);
    const current = await users.ensure(request.user.sub);

    const values: UserUpdate = {
      frequentlyUsedStations: body.frequentStations,
      walkingSpeed: body.walkingSpeed,
      preparationTimeMinutes: body.preparationTimeMinutes,
      priorityCondition: body.priorityCondition,
    };
    if (body.homeAddress !== undefined) {
      // 住所と座標は必ず組で更新する（片方だけ古いまま残さない）
      const location = await resolveHomeLocation(body);
      values.homeAddress = body.homeAddress;
      values.homeLatitude = location.lat;
      values.homeLongitude = location.lng;
    }
    // 同意の日時は最初の1回だけ記録する。同意の取り消しと、完了の取り消しは受け付けない
    if (body.acceptTerms === true && current.termsAcceptedAt === null) {
      values.termsAcceptedAt = now();
    }
    if (body.completeOnboarding === true) values.onboardingCompleted = true;

    // 指定のない項目（undefined）は更新しない
    const changes = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as UserUpdate;
    const updated =
      Object.keys(changes).length > 0 ? await users.update(request.user.sub, changes) : current;
    return toProfile(updated ?? current, email);
  });
}
