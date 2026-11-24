import { describe, expect, it } from 'vitest';
import {
  composePlan,
  type ComposedItem,
  type ComposeErrand,
  type ComposeInput,
  type ComposeStop,
  type Leg,
  type Store,
  type Travel,
  type TravelRequest,
} from '../../src/agent/compose.js';

const DATE = '2026-11-25';
const at = (time: string, date = DATE) => new Date(`${date}T${time}:00+09:00`);
const add = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const hhmm = (date: Date) => new Date(date.getTime() + 9 * 3600_000).toISOString().slice(11, 16);

const HOME = { lat: 35.64, lng: 139.67 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };
const SHINJUKU = { lat: 35.69, lng: 139.7 };

const errand = (
  id: string,
  start: string,
  end: string,
  overrides: Partial<ComposeErrand> = {},
): ComposeErrand => ({
  id,
  title: `用事${id}`,
  kind: 'other',
  at: 'place',
  name: id === 'e1' ? '東京駅' : '新宿駅',
  location: id === 'e1' ? TOKYO : SHINJUKU,
  start: at(start),
  end: at(end),
  ...overrides,
});

/**
 * 店。near からの距離は、offset（度）で変える。
 * hours を省くと終日営業、時刻の組なら対象日のその時間だけ営業、null なら営業時間が分からない
 */
const store = (
  name: string,
  near: { lat: number; lng: number },
  offset = 0.001,
  hours?: [string, string] | null,
): Store => ({
  placeId: `p-${name}`,
  name,
  location: { lat: near.lat + offset, lng: near.lng },
  openingPeriods:
    hours === null
      ? undefined
      : [
          {
            open: at(hours?.[0] ?? '00:00').toISOString(),
            close: (hours ? at(hours[1]) : at('00:00', '2026-11-28')).toISOString(),
          },
        ],
});

const stop = (
  id: string,
  anchor: string,
  when: 'before' | 'after',
  options: Store[],
  category = 'supermarket',
): ComposeStop => ({ id, category, anchor, when, options });

const input = (overrides: Partial<ComposeInput> = {}): ComposeInput => ({
  now: at('08:00'),
  date: DATE,
  home: HOME,
  mode: 'train',
  errands: [errand('e1', '13:00', '14:00')],
  stops: [],
  homeBetween: [],
  preparationMinutes: 30,
  priority: 'on_time',
  ...overrides,
});

/**
 * 移動の代用品。徒歩などは 10 分。電車は 30 分で、到着指定なら2分前に着く便、出発指定なら3分後に出る便。
 * 受け取った要求を requests に残す
 */
function fakeTravel(custom?: (request: TravelRequest) => Leg | undefined) {
  const requests: TravelRequest[] = [];
  const travel: Travel = async (request) => {
    requests.push(request);
    const leg = custom?.(request);
    if (leg) return leg;
    if (request.offline) return { mode: request.mode, minutes: 20, steps: [], approximate: true };
    if (request.mode !== 'train') return { mode: request.mode, minutes: 10, steps: [] };
    const arrival = request.arriveBy
      ? add(request.arriveBy, -2)
      : add(request.departAt ?? at('00:00'), 33);
    return {
      mode: 'train',
      minutes: 30,
      departure: add(arrival, -30),
      arrival,
      steps: [],
      stations: ['三軒茶屋', '東京'],
      stationExit: '丸の内北口',
      boardingPosition: '前',
    };
  };
  return { travel, requests };
}

/** 「時刻 種類 スロット 見出し」の一覧にする */
const lines = (items: ComposedItem[]) =>
  items.map((i) => `${hhmm(i.start)} ${i.itemType} ${i.slotType} ${i.title}`);

describe('composePlan：用事1件', () => {
  it('出発 → 移動 → 用事 → 移動 → 帰宅 を、到着から逆算して作る', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(input(), travel);

    // 遅刻厳禁なので 10 分前（12:50）に着く便を探す → 12:48 着・12:18 発
    expect(lines(plan.items)).toEqual([
      '12:18 departure DEPARTURE 自宅を出発',
      '12:18 move OUTBOUND 電車で東京駅へ',
      '13:00 errand MAIN 用事e1',
      '14:03 move RETURN 電車で自宅へ',
      '14:33 return RETURN 帰宅',
    ]);
    expect(plan.departure).toEqual(at('12:18'));
    expect(plan.return).toEqual(at('14:33'));
    expect(plan.items[0]?.description).toBe('準備開始の目安 11:48');
    expect(plan.warnings).toEqual([]);
    expect(plan.stations).toEqual(['三軒茶屋', '東京']);
  });

  it('移動の項目に、経路・出口・乗車位置をそのまま入れる。用事には元の ID を入れる', async () => {
    const { travel } = fakeTravel();
    const { items } = await composePlan(input(), travel);
    expect(items[1]).toMatchObject({
      transportMode: 'train',
      end: at('12:48'),
      stationExit: '丸の内北口',
      boardingPosition: '前',
      route: { durationMinutes: 30 },
      location: TOKYO,
    });
    expect(items[2]).toMatchObject({ sourceId: 'e1', locationName: '東京駅', end: at('14:00') });
  });

  it('遅刻厳禁でなければ、余裕は 5 分。食事の用事は meal にする', async () => {
    const { travel, requests } = fakeTravel();
    const plan = await composePlan(
      input({
        priority: 'save_money',
        errands: [errand('e1', '13:00', '14:00', { kind: 'meal' })],
      }),
      travel,
    );
    expect(requests[0]?.arriveBy).toEqual(at('12:55'));
    expect(plan.items[2]?.itemType).toBe('meal');
  });

  it('日をまたぐ用事は、終了のあとに帰る', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [errand('e1', '23:00', '23:00', { end: at('01:00', '2026-11-26') })],
      }),
      travel,
    );
    expect(plan.return).toEqual(at('01:33', '2026-11-26'));
  });

  it('徒歩・自転車・車のときは、すべての移動をその手段で取得する', async () => {
    const { travel, requests } = fakeTravel();
    const plan = await composePlan(input({ mode: 'bicycle' }), travel);
    expect(requests.map((r) => r.mode)).toEqual(['bicycle', 'bicycle']);
    expect(lines(plan.items)[1]).toBe('12:40 move OUTBOUND 自転車で東京駅へ');
  });
});

describe('composePlan：立寄り', () => {
  const stops = [
    stop('s1', 'home', 'before', [store('店A', HOME)]),
    stop('s2', 'home', 'after', [store('店B', HOME)]),
    stop('s3', 'e1', 'before', [store('店C', TOKYO)]),
    stop('s4', 'e1', 'after', [store('店D', TOKYO)], 'restaurant'),
  ];

  it('自宅・用事の前後に置く。区間の中は 出発地側 → 電車 → 到着地側', async () => {
    const { travel, requests } = fakeTravel();
    const plan = await composePlan(input({ stops }), travel);
    expect(lines(plan.items)).toEqual([
      '10:58 departure DEPARTURE 自宅を出発',
      '10:58 move OUTBOUND 徒歩で店Aへ',
      '11:08 stopover OUTBOUND 店A',
      '11:38 move OUTBOUND 電車で店Cへ',
      '12:08 stopover OUTBOUND 店C',
      '12:40 move OUTBOUND 徒歩で東京駅へ',
      '13:00 errand MAIN 用事e1',
      '14:00 move RETURN 徒歩で店Dへ',
      '14:10 meal RETURN 店D',
      '15:13 move RETURN 電車で店Bへ',
      '15:43 stopover RETURN 店B',
      '16:13 move RETURN 徒歩で自宅へ',
      '16:23 return RETURN 帰宅',
    ]);
    // 電車は区間ごとに1回だけ（立寄りの前後は徒歩）
    expect(requests.filter((r) => r.mode === 'train')).toHaveLength(2);
    const stopover = plan.items[2];
    expect(stopover).toMatchObject({
      sourceId: 's1',
      end: at('11:38'),
      store: { placeId: 'p-店A', name: '店A' },
    });
  });

  it('食事の立寄りは 60 分、買い物は 30 分', async () => {
    const { travel } = fakeTravel();
    const { items } = await composePlan(input({ stops }), travel);
    const minutes = (title: string) => {
      const item = items.find((i) => i.title === title);
      return item && (item.end.getTime() - item.start.getTime()) / 60_000;
    };
    expect(minutes('店A')).toBe(30);
    // 店D は 14:10 着、60 分の滞在のあと 15:10 以降の電車（15:13 発）まで
    expect(minutes('店D')).toBe(63);
  });

  it('用事が2件なら、最初の用事の後・最後の用事の前は、用事の間の区間に入る（MAIN）', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [errand('e1', '10:00', '11:00'), errand('e2', '15:00', '16:00')],
        stops: [
          stop('s1', 'e1', 'after', [store('店D', TOKYO)]),
          stop('s2', 'e2', 'before', [store('店E', SHINJUKU)]),
        ],
      }),
      travel,
    );
    // 次の用事（15:00）から逆算する。前の用事（11:00 まで）のあとは、その場所で待つ
    expect(lines(plan.items).slice(3, 9)).toEqual([
      '12:58 move MAIN 徒歩で店Dへ',
      '13:08 stopover MAIN 店D',
      '13:38 move MAIN 電車で店Eへ',
      '14:08 stopover MAIN 店E',
      '14:40 move MAIN 徒歩で新宿駅へ',
      '15:00 errand MAIN 用事e2',
    ]);
  });

  it('同じ側に複数あれば、出発地に近い順（到着地側は、到着地に近いものを最後）に回る', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        stops: [
          stop('s1', 'home', 'before', [store('遠い店', HOME, 0.005)]),
          stop('s2', 'home', 'before', [store('近い店', HOME, 0.001)]),
          stop('s3', 'e1', 'before', [store('駅前の店', TOKYO, 0.001)]),
          stop('s4', 'e1', 'before', [store('駅から遠い店', TOKYO, 0.005)]),
        ],
      }),
      travel,
    );
    expect(plan.items.filter((i) => i.itemType === 'stopover').map((i) => i.title)).toEqual([
      '近い店',
      '遠い店',
      '駅から遠い店',
      '駅前の店',
    ]);
  });

  it('置く場所の用事が無い立寄りは、自宅の周辺として扱う。候補の無い立寄りは外す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        stops: [stop('s1', 'e9', 'after', [store('店B', HOME)]), stop('s2', 'home', 'after', [])],
      }),
      travel,
    );
    expect(lines(plan.items).slice(-3)).toEqual([
      '14:33 stopover RETURN 店B',
      '15:03 move RETURN 徒歩で自宅へ',
      '15:13 return RETURN 帰宅',
    ]);
    expect(plan.droppedStopIds).toEqual(['s2']);
  });
});

describe('composePlan：買い物だけ', () => {
  const stops = [stop('s1', 'home', 'before', [store('店A', HOME)])];
  const now = at('09:00');

  it('今日は「現在＋準備時間」に出て、自宅 → 店 → 自宅', async () => {
    const { travel, requests } = fakeTravel();
    const plan = await composePlan(input({ now, errands: [], stops }), travel);
    expect(lines(plan.items)).toEqual([
      '09:30 departure DEPARTURE 自宅を出発',
      '09:30 move OUTBOUND 徒歩で店Aへ',
      '09:40 stopover OUTBOUND 店A',
      '10:10 move RETURN 徒歩で自宅へ',
      '10:20 return RETURN 帰宅',
    ]);
    expect(requests.every((r) => r.mode === 'walk')).toBe(true);
    expect(plan.assumptions).toEqual(['出発を 09:30 と仮定しました']);
  });

  it('明日は 10:00 に出ると仮定する。時刻の指定があれば、その時刻に出る', async () => {
    const { travel } = fakeTravel();
    const tomorrow = input({ now, errands: [], stops, date: '2026-11-26' });
    const assumed = await composePlan(tomorrow, travel);
    expect(assumed.departure).toEqual(at('10:00', '2026-11-26'));
    expect(assumed.assumptions).toEqual(['出発を 10:00 と仮定しました']);

    const given = await composePlan({ ...tomorrow, shoppingTime: '15:30' }, travel);
    expect(given.departure).toEqual(at('15:30', '2026-11-26'));
    expect(given.assumptions).toEqual([]);
  });

  it('指定の時刻が過ぎていれば、「現在＋準備時間」に出る', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({ now, errands: [], stops, shoppingTime: '08:00' }),
      travel,
    );
    expect(plan.departure).toEqual(at('09:30'));
  });

  it('自宅で迎える用事だけなら、外出は作らない。買い物と重なれば注意を出す', async () => {
    const { travel } = fakeTravel();
    const home = errand('e1', '09:30', '10:00', {
      at: 'home',
      name: undefined,
      location: undefined,
    });
    const none = await composePlan(input({ now, errands: [home] }), travel);
    expect(lines(none.items)).toEqual(['09:30 errand MAIN 用事e1']);
    expect(none.departure).toBeUndefined();
    expect(none.items[0]?.locationName).toBe('自宅');

    const overlapping = await composePlan(input({ now, errands: [home], stops }), travel);
    expect(overlapping.warnings).toEqual(['「用事e1」の時間に、外出が重なっています']);
  });
});

describe('composePlan：外出が複数', () => {
  const two = [errand('e1', '10:00', '11:00'), errand('e2', '16:00', '17:00')];

  it('用事が続くときは、帰宅せずに次の用事へ向かう（前の場所で待つ）', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(input({ errands: two }), travel);
    expect(lines(plan.items)).toEqual([
      '09:18 departure DEPARTURE 自宅を出発',
      '09:18 move OUTBOUND 電車で東京駅へ',
      '10:00 errand MAIN 用事e1',
      '15:18 move MAIN 電車で新宿駅へ',
      '16:00 errand MAIN 用事e2',
      '17:03 move RETURN 電車で自宅へ',
      '17:33 return RETURN 帰宅',
    ]);
  });

  it('「いったん帰宅する」を選んだ空きでは、帰宅と再出発を作る（途中は MAIN）', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(input({ errands: two, homeBetween: ['e1'] }), travel);
    expect(lines(plan.items)).toEqual([
      '09:18 departure DEPARTURE 自宅を出発',
      '09:18 move OUTBOUND 電車で東京駅へ',
      '10:00 errand MAIN 用事e1',
      '11:03 move MAIN 電車で自宅へ',
      '11:33 return MAIN 帰宅',
      '15:18 departure MAIN 自宅を出発',
      '15:18 move MAIN 電車で新宿駅へ',
      '16:00 errand MAIN 用事e2',
      '17:03 move RETURN 電車で自宅へ',
      '17:33 return RETURN 帰宅',
    ]);
    expect(plan.departure).toEqual(at('09:18'));
    expect(plan.return).toEqual(at('17:33'));
    expect(plan.items[5]?.description).toBeUndefined();
  });

  it('帰宅する時間が取れない空きは、「外で過ごす」に戻して注意を出す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [errand('e1', '10:00', '11:00'), errand('e2', '12:00', '13:00')],
        homeBetween: ['e1'],
      }),
      travel,
    );
    expect(plan.items.filter((i) => i.itemType === 'return')).toHaveLength(1);
    expect(plan.warnings).toEqual([
      '「用事e1」のあとは、帰宅する時間が取れないため、外で過ごす計画にしました',
    ]);
  });

  it('自宅で迎える用事は、外出を区切る', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        now: at('07:00'),
        errands: [
          errand('e1', '10:00', '11:00'),
          errand('e3', '13:00', '14:00', { at: 'home' }),
          errand('e2', '16:00', '17:00'),
        ],
        stops: [
          stop('s1', 'home', 'before', [store('店A', HOME)]),
          stop('s2', 'home', 'after', [store('店B', HOME)]),
        ],
      }),
      travel,
    );
    expect(lines(plan.items)).toEqual([
      '08:38 departure DEPARTURE 自宅を出発',
      '08:38 move OUTBOUND 徒歩で店Aへ',
      '08:48 stopover OUTBOUND 店A',
      '09:18 move OUTBOUND 電車で東京駅へ',
      '10:00 errand MAIN 用事e1',
      '11:03 move MAIN 電車で自宅へ',
      '11:33 return MAIN 帰宅',
      '13:00 errand MAIN 用事e3',
      '15:18 departure MAIN 自宅を出発',
      '15:18 move MAIN 電車で新宿駅へ',
      '16:00 errand MAIN 用事e2',
      '17:03 move RETURN 電車で店Bへ',
      '17:33 stopover RETURN 店B',
      '18:03 move RETURN 徒歩で自宅へ',
      '18:13 return RETURN 帰宅',
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it('外出先で迎える用事（stay）は、移動を作らず、その終了のあとに出る', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [
          errand('e1', '10:00', '11:00'),
          errand('e2', '11:30', '12:30', { at: 'stay', name: undefined, location: undefined }),
        ],
      }),
      travel,
    );
    expect(lines(plan.items)).toEqual([
      '09:18 departure DEPARTURE 自宅を出発',
      '09:18 move OUTBOUND 電車で東京駅へ',
      '10:00 errand MAIN 用事e1',
      '11:30 errand MAIN 用事e2',
      '12:33 move RETURN 電車で自宅へ',
      '13:03 return RETURN 帰宅',
    ]);
    expect(plan.items[3]).toMatchObject({ locationName: '東京駅', location: TOKYO });
  });

  it('外出先の用事が前に無い stay は、自宅で迎える', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({ errands: [errand('e1', '10:00', '11:00', { at: 'stay', location: undefined })] }),
      travel,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.locationName).toBe('自宅');
  });
});

describe('composePlan：うまくいかない場合', () => {
  it('最初の出発が過去なら、「現在＋準備時間」に出て、立寄りを外し、遅れを注意に出す', async () => {
    const { travel, requests } = fakeTravel();
    const plan = await composePlan(
      input({
        now: at('12:30'),
        stops: [stop('s1', 'home', 'before', [store('店A', HOME)])],
      }),
      travel,
    );
    // 13:00 に出て 13:03 発・13:33 着
    expect(lines(plan.items).slice(0, 3)).toEqual([
      '13:00 errand MAIN 用事e1',
      '13:03 departure DEPARTURE 自宅を出発',
      '13:03 move OUTBOUND 電車で東京駅へ',
    ]);
    expect(plan.warnings).toEqual([
      '出発までの時間が足りないため、「店A」への立寄りを外しました',
      '「用事e1」に、約33分遅れる見込みです',
    ]);
    expect(plan.droppedStopIds).toEqual(['s1']);
    expect(requests.at(-1)).toMatchObject({ mode: 'train', departAt: at('13:00') });
  });

  it('用事の間で間に合わなければ、その区間の立寄りを外して取り直す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [errand('e1', '10:00', '11:00'), errand('e2', '12:00', '13:00')],
        stops: [stop('s1', 'e2', 'before', [store('店E', SHINJUKU)])],
      }),
      travel,
    );
    expect(plan.items.some((i) => i.itemType === 'stopover')).toBe(false);
    expect(plan.warnings).toEqual(['移動の時間が足りないため、「店E」への立寄りを外しました']);
    // 前の用事が終わったら（11:00）すぐ出る便に乗る
    expect(lines(plan.items)[3]).toBe('11:03 move MAIN 電車で新宿駅へ');
  });

  it('立寄りが無くても足りなければ、前の用事の終了に出る便で時刻を置き、遅れを注意に出す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({ errands: [errand('e1', '10:00', '11:00'), errand('e2', '11:30', '12:00')] }),
      travel,
    );
    // 11:20 に着くには 10:48 発だが、用事e1 は 11:00 まで。11:03 発・11:33 着になる
    expect(plan.warnings).toEqual(['「用事e2」に、約3分遅れる見込みです']);
    expect(lines(plan.items)[3]).toBe('11:03 move MAIN 電車で新宿駅へ');
  });

  it('用事どうしが重なっていても計画を作り、注意を出す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({ errands: [errand('e1', '10:00', '12:00'), errand('e2', '11:00', '13:00')] }),
      travel,
    );
    expect(plan.warnings).toEqual([
      '「用事e1」と「用事e2」の時間が重なっています',
      '「用事e2」に、約93分遅れる見込みです',
    ]);
    expect(plan.items.filter((i) => i.itemType === 'errand')).toHaveLength(2);
  });

  it('遅れて着く用事の次の出発に食い込むときは、波及の注意を出す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        now: at('09:50'),
        errands: [errand('e1', '10:00', '10:30'), errand('e2', '11:30', '12:00')],
      }),
      travel,
    );
    // 10:20 に出て 10:53 着。次の区間は 10:48 発
    expect(plan.warnings).toEqual([
      '「用事e1」に、約53分遅れる見込みです',
      '遅れにより、そのあとの予定にも影響が出る可能性があります',
    ]);
  });

  it('経路が取れず概算になった区間は、注意と項目の説明に出す', async () => {
    const { travel } = fakeTravel((request) =>
      request.arriveBy ? { mode: 'train', minutes: 40, steps: [], approximate: true } : undefined,
    );
    const plan = await composePlan(input(), travel);
    expect(plan.warnings).toEqual([
      '自宅から東京駅までの経路を取得できませんでした（概算の時刻です）',
    ]);
    expect(plan.items[1]).toMatchObject({
      start: at('12:10'),
      end: at('12:50'),
      description: '経路を取得できなかったため、概算の時刻です',
    });
  });
});

describe('composePlan：営業時間（確定した時刻で確かめる）', () => {
  // 立寄りは 11:48 着・12:18 発（12:50 に着く電車から逆算）
  const closed = store('閉まっている店', HOME, 0.001, ['12:10', '20:00']);
  const open = store('開いている店', HOME, 0.002);
  const unknown = store('営業時間の分からない店', HOME, 0.003, null);

  it('営業時間外なら、次の候補に替えて、その区間だけを取り直す', async () => {
    const { travel, requests } = fakeTravel();
    const plan = await composePlan(
      input({ stops: [stop('s1', 'home', 'before', [closed, unknown, open])] }),
      travel,
    );
    expect(plan.items.find((i) => i.itemType === 'stopover')?.title).toBe('開いている店');
    expect(plan.warnings).toEqual([]);
    // 1巡目：往路2（徒歩・電車）＋復路1。取り直し：往路2
    expect(requests).toHaveLength(5);
  });

  it('替えの候補が無ければ、立寄りを外して注意を出す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({ stops: [stop('s1', 'home', 'before', [closed, unknown])] }),
      travel,
    );
    expect(plan.items.some((i) => i.itemType === 'stopover')).toBe(false);
    expect(plan.warnings).toEqual([
      '到着する時刻に営業していないため、「閉まっている店」への立寄りを外しました',
    ]);
    expect(plan.droppedStopIds).toEqual(['s1']);
    expect(plan.departure).toEqual(at('12:18'));
  });

  it('滞在の途中で閉まる店も、営業時間外として扱う', async () => {
    const { travel } = fakeTravel();
    const closing = store('すぐ閉まる店', HOME, 0.001, ['09:00', '12:00']);
    const plan = await composePlan(
      input({ stops: [stop('s1', 'home', 'before', [closing])] }),
      travel,
    );
    expect(plan.droppedStopIds).toEqual(['s1']);
  });

  it('取り直しは1巡だけ。取り直したあとも営業時間外なら、注意を出す', async () => {
    // 取り直すと電車が1時間早くなり、替えの店が開く前に着く
    let trains = 0;
    const { travel } = fakeTravel((request) => {
      if (request.mode !== 'train' || !request.arriveBy) return undefined;
      trains += 1;
      const shift = trains === 1 ? 0 : 60;
      return {
        mode: 'train',
        minutes: 30,
        departure: add(request.arriveBy, -32 - shift),
        arrival: add(request.arriveBy, -2 - shift),
        steps: [],
      };
    });
    const narrow = store('昼だけの店', HOME, 0.002, ['11:30', '12:30']);
    const plan = await composePlan(
      input({ stops: [stop('s1', 'home', 'before', [closed, narrow])] }),
      travel,
    );
    expect(trains).toBe(2);
    expect(plan.warnings).toEqual([
      '「昼だけの店」は、到着する時刻（10:48）に営業していない可能性があります',
    ]);
  });

  it('残り時間が無いときは、取り直しを概算で行う（外部 API を呼ばない指定を渡す）', async () => {
    const { travel, requests } = fakeTravel();
    const plan = await composePlan(
      input({
        stops: [stop('s1', 'home', 'before', [closed])],
        canRetry: () => false,
      }),
      travel,
    );
    expect(requests.filter((r) => r.offline)).toHaveLength(1);
    expect(plan.warnings).toContain(
      '自宅から東京駅までの経路を取得できませんでした（概算の時刻です）',
    );
  });
});

describe('composePlan：レビューで見つかった境界', () => {
  const stay = (id: string, start: string, end: string) =>
    errand(id, start, end, { at: 'stay', name: undefined, location: undefined });

  it('「外で過ごす」に戻した空きでは、前後の立寄りを外して間に合わせる', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [errand('e1', '10:00', '11:00'), errand('e2', '12:00', '13:00')],
        homeBetween: ['e1'],
        stops: [stop('s1', 'e2', 'before', [store('店E', SHINJUKU)])],
      }),
      travel,
    );
    expect(plan.warnings).toEqual([
      '「用事e1」のあとは、帰宅する時間が取れないため、外で過ごす計画にしました',
      '移動の時間が足りないため、「店E」への立寄りを外しました',
    ]);
    expect(lines(plan.items)[3]).toBe('11:18 move MAIN 電車で新宿駅へ');
  });

  it('外出先で迎える用事（stay）と次の用事の重なりも、注意に出す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [
          errand('e1', '10:00', '11:00'),
          stay('s', '11:00', '12:30'),
          errand('e2', '12:00', '13:00'),
        ],
      }),
      travel,
    );
    expect(plan.warnings).toEqual([
      '「用事s」と「用事e2」の時間が重なっています',
      '「用事e2」に、約63分遅れる見込みです',
    ]);
  });

  it('隣どうしでない用事の重なりも、注意に出す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [
          errand('e1', '10:00', '15:00'),
          stay('e2', '11:00', '12:00'),
          stay('e3', '13:00', '14:00'),
        ],
      }),
      travel,
    );
    expect(plan.warnings).toEqual([
      '「用事e1」と「用事e2」の時間が重なっています',
      '「用事e1」と「用事e3」の時間が重なっています',
    ]);
  });

  it('「いったん帰宅する」と立寄りの置く場所は、stay の用事の ID でも指定できる', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [
          errand('e1', '10:00', '11:00'),
          stay('s', '11:00', '12:00'),
          errand('e2', '18:00', '19:00'),
        ],
        homeBetween: ['s'],
        stops: [stop('s1', 's', 'after', [store('店D', TOKYO)])],
      }),
      travel,
    );
    expect(lines(plan.items).slice(4, 8)).toEqual([
      '12:00 move MAIN 徒歩で店Dへ',
      '12:10 stopover MAIN 店D',
      '12:43 move MAIN 電車で自宅へ',
      '13:13 return MAIN 帰宅',
    ]);
  });

  it('「現在＋準備時間」が到着の指定と同じ時刻でも、今すぐ出る経路を取り直す', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        now: at('12:20'),
        stops: [stop('s1', 'e1', 'before', [store('店C', TOKYO)])],
      }),
      travel,
    );
    expect(plan.departure).toEqual(at('12:53'));
    expect(plan.droppedStopIds).toEqual(['s1']);
    expect(plan.warnings).toContain('「用事e1」に、約23分遅れる見込みです');
  });

  it('余裕の分が取れないだけなら、前の用事の終了に出る便にして、注意を出さない', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({ errands: [errand('e1', '10:00', '11:00'), errand('e2', '11:35', '12:00')] }),
      travel,
    );
    // 逆算（10:53 発）は用事e1 の途中なので使わない。11:03 発・11:33 着
    expect(lines(plan.items)[3]).toBe('11:03 move MAIN 電車で新宿駅へ');
    expect(plan.warnings).toEqual([]);
  });

  it('営業時間は、滞在の時間だけで確かめる（電車を待つ時間は含めない）', async () => {
    const { travel } = fakeTravel();
    // 14:10 着、60 分の滞在（15:10 まで）。電車は 15:13 発
    const meal = store('15時すぎに閉まる店', TOKYO, 0.001, ['09:00', '15:11']);
    const plan = await composePlan(
      input({ stops: [stop('s1', 'e1', 'after', [meal], 'restaurant')] }),
      travel,
    );
    expect(plan.droppedStopIds).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('自宅で迎える用事が外出を区切るときは、「いったん帰宅する」の指定を使わない', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(
      input({
        errands: [
          errand('e1', '10:00', '11:00'),
          errand('h', '11:33', '11:40', { at: 'home' }),
          errand('e2', '12:15', '13:00'),
        ],
        homeBetween: ['e1'],
      }),
      travel,
    );
    expect(plan.warnings).toEqual(['「用事h」の時間に、外出が重なっています']);
    // 帰宅と、自宅の用事の開始が同じ時刻なら、帰宅が先
    expect(lines(plan.items).slice(3, 6)).toEqual([
      '11:03 move MAIN 電車で自宅へ',
      '11:33 return MAIN 帰宅',
      '11:33 errand MAIN 用事h',
    ]);
  });

  it('取り直すのは、中身の変わった区間だけ', async () => {
    const { travel, requests } = fakeTravel();
    const closed = store('閉まっている店', SHINJUKU, 0.001, ['20:00', '22:00']);
    const plan = await composePlan(
      input({
        errands: [errand('e1', '10:00', '11:00'), errand('e2', '16:00', '17:00')],
        stops: [stop('s1', 'e2', 'before', [closed])],
      }),
      travel,
    );
    expect(plan.droppedStopIds).toEqual(['s1']);
    // 1巡目：自宅→e1（1）、e1→e2（電車・徒歩）、e2→自宅（1）。取り直し：e1→e2（1）
    expect(requests).toHaveLength(5);
  });

  it('徒歩・車のときは、立寄りの前後も同じ手段で移動する', async () => {
    const { travel, requests } = fakeTravel();
    await composePlan(
      input({ mode: 'car', stops: [stop('s1', 'home', 'before', [store('店A', HOME)])] }),
      travel,
    );
    expect(requests.every((r) => r.mode === 'car')).toBe(true);
  });
});

describe('composePlan：出発の確認', () => {
  it('出発までの時間が準備時間より短いときは、注意を出す（出発は遅らせない）', async () => {
    const { travel } = fakeTravel();
    const plan = await composePlan(input({ now: at('12:00') }), travel);
    expect(plan.departure).toEqual(at('12:18'));
    expect(plan.warnings).toEqual(['出発まで約18分です。準備の時間が足りない可能性があります']);
  });

  it('店を替えて取り直したあとに出発が過去になったら、注意を出す', async () => {
    // 取り直すと、電車が 30 分早くなる
    let trains = 0;
    const { travel } = fakeTravel((request) => {
      if (request.mode !== 'train' || !request.arriveBy) return undefined;
      trains += 1;
      const arrival = add(request.arriveBy, trains === 1 ? -2 : -32);
      return { mode: 'train', minutes: 30, departure: add(arrival, -30), arrival, steps: [] };
    });
    const closed = store('閉まっている店', HOME, 0.001, ['12:10', '20:00']);
    const plan = await composePlan(
      input({
        now: at('11:30'),
        stops: [stop('s1', 'home', 'before', [closed, store('店A', HOME)])],
      }),
      travel,
    );
    // 1巡目は 11:38 発。取り直すと 11:08 発（現在は 11:30）
    expect(plan.departure).toEqual(at('11:08'));
    expect(plan.warnings).toEqual(['自宅を出る時刻（11:08）に、約22分間に合いません']);
  });
});
