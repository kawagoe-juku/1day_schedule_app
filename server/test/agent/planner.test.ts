import { describe, expect, it } from 'vitest';
import { ExternalApiError } from '../../src/adapters/http.js';
import type { PlanContext } from '../../src/agent/context.js';
import {
  answerPlan,
  hasUnknownStation,
  removeItem,
  revisePlan,
  startPlan,
  type Outcome,
  type PlannerDeps,
} from '../../src/agent/planner.js';
import { SLOT_IDS } from '../../src/agent/slots.js';
import { AppError } from '../../src/errors.js';

import {
  allDay,
  at,
  decide,
  errand,
  event,
  fakeAi,
  fakeMaps,
  HOME,
  INPUT,
  intent,
  NOW,
  SUPERMARKET,
  TOKYO,
  travel,
  type DecideData,
} from '../helpers/agent-fakes.js';

const context = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  user: {
    walkingSpeed: 'normal',
    preparationTimeMinutes: 30,
    priorityCondition: 'on_time',
    calendarUsageConsent: true,
    memoUsageConsent: true,
  } as PlanContext['user'],
  home: HOME,
  programs: [],
  memos: [],
  events: [],
  calendarFailed: false,
  ...overrides,
});

function setup(
  answers: Parameters<typeof fakeAi>[0] = {},
  mapOptions: Parameters<typeof fakeMaps>[0] = {},
) {
  const { ai, calls } = fakeAi(answers);
  const { maps, searches } = fakeMaps(mapOptions);
  const deps: PlannerDeps = {
    ai,
    maps,
    travel: () => travel,
    now: () => NOW,
    remainingMs: () => 10_000,
  };
  return { deps, calls, searches };
}

/** 保存された計画の代わり（回答のテスト用） */
const saved = (outcome: Outcome) => ({
  draft: outcome.draft,
  clarificationCount: outcome.questions,
  inputText: INPUT,
});
const titles = (outcome: Outcome) => outcome.composed?.items.map((i) => i.title);

describe('startPlan（新規の生成）', () => {
  it('確認が要らなければ、1回で計画を完成させる。全スロットを順番どおりに評価する', async () => {
    const { deps, calls } = setup();
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.status).toBe('completed');
    expect(calls.map((c) => c.operation)).toEqual(['interpret', 'decide']);
    expect(outcome.draft.slots?.map((s) => s.slot)).toEqual(SLOT_IDS);
    expect(titles(outcome)).toEqual([
      '自宅を出発',
      '電車で東京駅へ',
      '待ち合わせ',
      '電車でサンプルスーパー自宅前店へ',
      'サンプルスーパー自宅前店',
      '徒歩で自宅へ',
      '帰宅',
    ]);
    expect(outcome.composed?.items[4]).toMatchObject({ itemType: 'stopover', sourceId: 's2' });
    expect(outcome.questions).toBe(0);
  });

  it('品目は応答にだけ入れ、下書き・記録には入れない（入力文・プロンプトも入れない）', async () => {
    const { deps } = setup();
    const outcome = await startPlan(deps, context({ memos: ['排水口のネット'] }), INPUT);
    expect(outcome.purchaseItems).toEqual([{ sourceId: 's2', items: ['カレーの食材'] }]);
    const stored = JSON.stringify([outcome.draft, outcome.sessions, outcome.warnings]);
    expect(stored).not.toMatch(/カレー|排水口|買いたい|読み取り係|判断係/);
    expect(outcome.sessions.map((s) => s.sessionType)).toEqual(['intent', 'compose']);
    expect(outcome.sessions[0]?.inputSummary).toBe('入力 25文字／メモ 1件／予定 0件');
  });

  it('メモと予定は、データとして AI に渡す（指示には入れない）', async () => {
    const { deps, calls } = setup();
    await startPlan(
      deps,
      context({ memos: ['牛乳'], events: [event('c1', '10:00', '11:00', { date: '2026-11-26' })] }),
      INPUT,
    );
    expect(calls[0]?.data).toMatchObject({
      text: INPUT,
      memos: ['牛乳'],
      events: [{ id: 'c1', date: 'tomorrow', title: '予定c1' }],
    });
    expect(calls[0]?.system).not.toMatch(/牛乳|予定c1|カレー/);
  });

  it('不適切な入力・今日と明日以外の日付・何も読み取れない入力は 400（計画は作らない）', async () => {
    for (const answer of [
      intent({ rejected: true, errands: [], stops: [] }),
      intent({ date: 'other' }),
      intent({ errands: [], stops: [] }),
    ]) {
      const { deps, calls } = setup({ interpret: answer });
      const error = await startPlan(deps, context(), INPUT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(400);
      expect(calls).toHaveLength(1);
    }
  });

  it('予定が2件以上なら、まず予定の一覧を返す（店の検索も判断もまだしない）', async () => {
    const { deps, calls, searches } = setup();
    const outcome = await startPlan(
      deps,
      context({ events: [event('c1', '10:00', '11:00')] }),
      INPUT,
    );
    expect(outcome).toMatchObject({ status: 'clarifying', questions: 0 });
    expect(outcome.draft.pending).toEqual({
      kind: 'selection',
      question: '計画に入れる予定を選んでください',
    });
    expect(outcome.purchaseItems).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(searches).toHaveLength(0);
  });

  it('終了の時刻が無い用事は、質問を返す', async () => {
    const { deps } = setup({ interpret: intent({ errands: [errand({ endTime: null })] }) });
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome).toMatchObject({ status: 'clarifying', questions: 1 });
    expect(outcome.draft.pending).toMatchObject({
      kind: 'question',
      missing: ['end'],
      question: '「待ち合わせ」について、何時ごろまでかを教えてください',
    });
  });

  it('カレンダーを取得できなかったときは、注意を出して続ける', async () => {
    const { deps } = setup();
    const outcome = await startPlan(deps, context({ calendarFailed: true }), INPUT);
    expect(outcome.status).toBe('completed');
    expect(outcome.warnings).toContain(
      'カレンダーの予定を取得できなかったため、予定なしで計画を作りました',
    );
  });
});

describe('answerPlan（確認への回答）', () => {
  it('予定の一覧で外した予定は、計画に入らない。迎え方・帰宅の指定を反映する', async () => {
    const { deps, calls } = setup();
    const ctx = context({
      events: [event('c1', '09:30', '10:00', { place: undefined }), event('c2', '18:00', '19:00')],
    });
    const first = await startPlan(deps, ctx, INPUT);
    const outcome = await answerPlan(deps, ctx, saved(first), {
      selectedIds: ['e1', 'e2'],
      places: [{ id: 'e2', at: 'home' }],
    });
    expect(outcome.status).toBe('completed');
    expect(titles(outcome)).toEqual([
      '予定c1',
      '自宅を出発',
      '電車で東京駅へ',
      '待ち合わせ',
      '電車で自宅へ',
      '帰宅',
    ]);
    expect(outcome.purchaseItems).toBeUndefined();
    // 一覧への回答では、読み取り（AI①）を呼ばない
    expect(calls.map((c) => c.operation)).toEqual(['interpret', 'decide']);
    expect(outcome.sessions.map((s) => s.sessionType)).toEqual(['clarify', 'compose']);
  });

  it('質問への自由入力は、差分だけを読み取って反映する（ID・選択は変わらない）', async () => {
    const { deps, calls } = setup({
      interpret: intent({ errands: [errand({ endTime: null })] }),
      patch: { place: null, placeIsSpecific: true, startTime: null, endTime: '15:00' },
    });
    const first = await startPlan(deps, context(), INPUT);
    const outcome = await answerPlan(deps, context(), saved(first), { answer: '15時まで' });
    expect(outcome.status).toBe('completed');
    expect(outcome.draft.errands[0]).toMatchObject({ id: 'e1', end: at('15:00'), selected: true });
    const patch = calls.find((c) => c.operation === 'patch');
    expect(patch?.data).toMatchObject({
      errand: { title: '待ち合わせ', place: '東京駅', startTime: '13:00', endTime: null },
      answer: '15時まで',
    });
    // 入力した元の計画は書き換えない（保存に失敗しても、やり直せる）
    expect(first.draft.errands[0]?.end).toBeUndefined();
  });

  it('場所が固有でない用事は、候補を出す。選んだ候補を、その用事の場所にする', async () => {
    const dentist = {
      placeId: 'p-dental',
      name: 'さくら歯科',
      address: '世田谷区',
      location: TOKYO,
    };
    const { deps } = setup(
      {
        interpret: intent({
          errands: [errand({ title: '歯医者', place: '歯医者', placeIsSpecific: false })],
          stops: [],
        }),
      },
      { places: { 歯医者: [dentist, { ...dentist, placeId: 'p-2', name: 'みどり歯科' }] } },
    );
    const first = await startPlan(deps, context(), INPUT);
    expect(first.draft.pending).toMatchObject({
      kind: 'place',
      question: '「歯医者」の場所はどちらですか？',
      options: [
        { id: 'p1', name: 'さくら歯科' },
        { id: 'p2', name: 'みどり歯科' },
      ],
    });
    const outcome = await answerPlan(deps, context(), saved(first), { selectedIds: ['p2'] });
    expect(outcome.status).toBe('completed');
    expect(titles(outcome)).toContain('電車でみどり歯科へ');

    const unknown = await answerPlan(deps, context(), saved(first), { selectedIds: ['p9'] }).catch(
      (e: unknown) => e,
    );
    expect((unknown as AppError).statusCode).toBe(400);
  });

  it('質問は2回まで。3回目は出さず、残りを仮定で埋めて完成させる', async () => {
    const { deps } = setup({
      interpret: intent({ errands: [errand({ startTime: null, endTime: null })], stops: [] }),
      // 回答からは何も分からなかった
      patch: { place: null, placeIsSpecific: true, startTime: null, endTime: null },
    });
    const first = await startPlan(deps, context(), INPUT);
    expect(first).toMatchObject({ status: 'clarifying', questions: 1 });
    const second = await answerPlan(deps, context(), saved(first), { answer: 'わからない' });
    expect(second).toMatchObject({ status: 'clarifying', questions: 2 });
    const third = await answerPlan(deps, context(), saved(second), { answer: 'わからない' });
    expect(third.status).toBe('completed');
    expect(third.assumptions).toEqual([
      '「待ち合わせ」の開始を 11:00 と仮定しました',
      '「待ち合わせ」の所要時間を 60 分と仮定しました',
    ]);
    expect(third.draft.errands[0]?.assumed).toEqual(['start', 'end']);
  });

  it('回答の種類が合わなければ 400', async () => {
    const { deps } = setup({ interpret: intent({ errands: [errand({ endTime: null })] }) });
    const question = await startPlan(deps, context(), INPUT);
    const error = await answerPlan(deps, context(), saved(question), { selectedIds: ['e1'] }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).statusCode).toBe(400);
  });

  it('確認の対象の予定が使えなくなったら、回答を反映せずに続きから作る', async () => {
    const { deps, calls } = setup(
      { interpret: intent({ errands: [], stops: [SUPERMARKET] }) },
      { places: { いつもの店: [] } },
    );
    const ctx = context({
      events: [event('c1', '15:00', '16:00', { title: '会食', place: 'いつもの店' })],
    });
    // 場所が見つからないので、場所の候補の確認になる
    const first = await startPlan(deps, ctx, '牛乳を買いたい');
    expect(first.draft.pending).toMatchObject({ kind: 'place', errandId: 'e1' });
    const off = context({ user: { ...ctx.user, calendarUsageConsent: false } });
    const outcome = await answerPlan(deps, off, saved(first), { answer: '続ける' });
    expect(outcome.status).toBe('completed');
    expect(outcome.draft.errands).toEqual([]);
    expect(calls.map((c) => c.operation)).not.toContain('patch');
  });

  it('カレンダーの同意を OFF にしたあとの回答では、カレンダーの予定を落とす', async () => {
    const { deps } = setup();
    const ctx = context({ events: [event('c1', '16:00', '17:00')] });
    const first = await startPlan(deps, ctx, INPUT);
    const off = context({ user: { ...ctx.user, calendarUsageConsent: false } });
    const outcome = await answerPlan(deps, off, saved(first), { selectedIds: ['e1'] });
    expect(outcome.draft.errands.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('整合性チェック', () => {
  it('立寄りだけの入力で、寄れる店が無ければ、完成にしない（生成回数を使わない）', async () => {
    const { deps } = setup({
      interpret: intent({ errands: [], stops: [SUPERMARKET] }),
      decide: (data) => ({
        ...decide(data),
        stopovers: [{ stopId: 's1', candidate: 'c99', when: 'after' }],
      }),
    });
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.status).toBe('error');
    expect(outcome.composed).toBeUndefined();
    expect(outcome.warnings).toEqual([
      '寄れる店が見つからなかったため、「スーパー」への立寄りを外しました',
      '計画に入れられる用事・立寄りがありません',
    ]);
  });

  it('候補に無い番号を選んだ立寄り・選ばれなかった立寄りは、外して注意を出す', async () => {
    const { deps } = setup({
      interpret: intent({ stops: [SUPERMARKET, { ...SUPERMARKET, category: 'drugstore' }] }),
      decide: (data) => ({
        ...decide(data),
        stopovers: [{ stopId: 's2', candidate: 'c99', when: 'after' }],
      }),
    });
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.status).toBe('completed');
    expect(outcome.composed?.items.some((i) => i.itemType === 'stopover')).toBe(false);
    expect(outcome.warnings).toEqual([
      '寄れる店が見つからなかったため、「スーパー」への立寄りを外しました',
      '寄れる店が見つからなかったため、「ドラッグストア」への立寄りを外しました',
    ]);
    // 立寄りが残らなかったスロットの判断文は、定型文にする
    expect(outcome.draft.slots?.find((s) => s.slot === 'return_stops')?.decision).toBe(
      '立寄りはありません',
    );
  });

  it('AI が選んだ置き方が、その店の営業時間に合わなければ、合う置き方にする', async () => {
    const { deps } = setup(
      {
        decide: (data) => ({
          ...decide(data),
          stopovers: [{ stopId: 's2', candidate: 'c1', when: 'before' }],
        }),
      },
      {
        stores: ({ near }) =>
          near === HOME
            ? [
                {
                  placeId: 'evening',
                  name: '夕方からの店',
                  location: { lat: HOME.lat + 0.001, lng: HOME.lng },
                  openingPeriods: [{ open: at('14:00'), close: at('22:00') }],
                },
              ]
            : [],
      },
    );
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.draft.stops[0]).toMatchObject({ anchor: 'home', when: 'after' });
  });

  it('店の検索に失敗したら、立寄りなしで続け、注意を出す', async () => {
    const { deps } = setup(
      {},
      { stores: () => new ExternalApiError('google_maps', 'places_search_text', 'timeout') },
    );
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.status).toBe('completed');
    expect(outcome.warnings).toEqual([
      '店を検索できなかったため、「スーパー」への立寄りを外しました',
    ]);
  });

  it('判断文・仮定に、確認の取れない駅名があれば、その文を捨てる', async () => {
    const { deps } = setup({
      interpret: intent({ assumptions: ['品川駅で乗り換えると仮定', '夕方を17時と解釈'] }),
      decide: (data) => ({
        ...decide(data),
        slots: SLOT_IDS.map((slot, i) => ({
          slot,
          decision:
            ['渋谷駅で乗り換えます', '東京駅には余裕で着きます', '', '三軒茶屋駅から乗ります'][i] ??
            '',
        })),
      }),
    });
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.draft.slots?.slice(0, 4).map((s) => s.decision)).toEqual([
      '問題はありません',
      '東京駅には余裕で着きます',
      // 往路に立寄りが無いので、定型文
      '立寄りはありません',
      '三軒茶屋駅から乗ります',
    ]);
    expect(outcome.assumptions).toEqual(['夕方を17時と解釈']);
  });

  it('件名の駅名が、入力文にも確定した場所名にも無ければ、場所名に置き換える', async () => {
    const { deps } = setup({
      interpret: intent({
        errands: [errand({ title: '新橋駅で会食', place: '東京駅' })],
        stops: [],
      }),
    });
    const outcome = await startPlan(deps, context(), INPUT);
    expect(titles(outcome)).toContain('東京駅での用事');
  });

  it('予定の件名は、駅名が入っていても置き換えない（利用者が登録したもの）', async () => {
    const { deps } = setup({ interpret: intent({ errands: [], assumptions: [] }) });
    const ctx = context({
      events: [event('c1', '15:00', '16:00', { title: '渋谷駅前で歯医者', place: 'さくら歯科' })],
    });
    const outcome = await startPlan(deps, ctx, '牛乳を買いたい');
    expect(titles(outcome)).toContain('渋谷駅前で歯医者');
  });

  it('確認で止まる応答でも、入力にも予定にも無い駅名を含む仮定は出さない', async () => {
    const { deps } = setup({
      interpret: intent({
        errands: [errand({ endTime: null })],
        assumptions: ['品川駅で乗り換えると仮定', '東京駅の丸の内側と解釈'],
      }),
    });
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.status).toBe('clarifying');
    expect(outcome.assumptions).toEqual(['東京駅の丸の内側と解釈']);
  });

  it('判断（AI②）の形が合わなければ、1回だけやり直す。時間が無ければやり直さない', async () => {
    const failing = () => {
      let count = 0;
      return {
        decide: (data: DecideData) =>
          (count += 1) === 1
            ? new ExternalApiError('bedrock', 'decide', 'invalid_response')
            : decide(data),
        count: () => count,
      };
    };
    const retried = failing();
    const ok = setup({ decide: retried.decide });
    expect((await startPlan(ok.deps, context(), INPUT)).status).toBe('completed');
    expect(retried.count()).toBe(2);

    const late = failing();
    const { deps } = setup({ decide: late.decide });
    deps.remainingMs = () => 3000;
    await expect(startPlan(deps, context(), INPUT)).rejects.toBeInstanceOf(ExternalApiError);
    expect(late.count()).toBe(1);
  });

  it('締め切りを過ぎていたら、場所・店の検索も判断も始めない', async () => {
    const { deps, calls, searches } = setup();
    deps.remainingMs = () => 0;
    await expect(startPlan(deps, context(), INPUT)).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls.map((c) => c.operation)).toEqual(['interpret']);
    expect(searches).toEqual([]);
  });

  it('店が見つからず外した立寄りは、選択からも外す（件数の上限に数えない）', async () => {
    const { deps } = setup({}, { stores: () => [] });
    const outcome = await startPlan(deps, context(), INPUT);
    expect(outcome.status).toBe('completed');
    expect(outcome.draft.stops).toMatchObject([{ id: 's2', selected: false }]);
  });

  it('場所が決まらず、用事も立寄りも残らなければ、エラーの計画にする', async () => {
    const { deps } = setup(
      {
        interpret: intent({
          errands: [errand({ place: 'どこか', placeIsSpecific: false })],
          stops: [],
        }),
        patch: { place: 'どこか', placeIsSpecific: false, startTime: null, endTime: null },
      },
      { places: { どこか: [] } },
    );
    const first = await startPlan(deps, context(), INPUT);
    const second = await answerPlan(deps, context(), saved(first), { answer: 'どこか' });
    const outcome = await answerPlan(deps, context(), saved(second), { answer: 'どこか' });
    expect(outcome.status).toBe('error');
    expect(outcome.warnings).toEqual([
      '「待ち合わせ」は、場所が決まらなかったため、計画から外しました',
      '計画に入れられる用事・立寄りがありません',
    ]);
  });

  it('ポイント優先のときは、対象の店だけを AI に渡す', async () => {
    const { deps, calls } = setup(
      {},
      {
        stores: ({ near }) =>
          ['サンプルスーパー', 'イオン 三軒茶屋店'].map((name, i) => ({
            placeId: `${name}-${near?.lat}`,
            name,
            location: { lat: (near ?? HOME).lat + 0.001 * (i + 1), lng: (near ?? HOME).lng },
            openingPeriods: allDay,
          })),
      },
    );
    const ctx = context({ programs: ['waon'] });
    ctx.user = { ...ctx.user, priorityCondition: 'points' };
    await startPlan(deps, ctx, INPUT);
    const data = calls.at(-1)?.data as { priority: string; candidates: { name: string }[] };
    expect(data.priority).toBe('points');
    expect(new Set(data.candidates.map((c) => c.name))).toEqual(new Set(['イオン 三軒茶屋店']));
  });
});

describe('hasUnknownStation', () => {
  const stations = ['三軒茶屋', '大宮（埼玉県）', '東京'];
  it('経路の駅名（括弧書きを外す）・入力文にある駅名は、知っている名称として扱う', () => {
    expect(hasUnknownStation('大宮駅で降ります', stations, '')).toBe(false);
    expect(hasUnknownStation('最寄りの三軒茶屋駅から', stations, '')).toBe(false);
    expect(hasUnknownStation('渋谷駅に寄ります', stations, '明日は渋谷駅で待ち合わせ')).toBe(false);
    expect(hasUnknownStation('駅から歩きます。最寄りの駅です', stations, '')).toBe(false);
  });
  it('駅名でない語（最寄駅・乗換駅・各駅停車など）は、駅名として扱わない', () => {
    for (const text of [
      '最寄駅から歩きます',
      '乗換駅での待ち時間に注意',
      '各駅停車で向かいます',
      '到着駅の出口に注意',
    ]) {
      expect(hasUnknownStation(text, stations, '')).toBe(false);
    }
  });
  it('入力文の駅名と、末尾の1文字が同じだけの別の駅は通さない', () => {
    expect(hasUnknownStation('四ツ谷駅で降ります', stations, '渋谷駅で待ち合わせ')).toBe(true);
    expect(hasUnknownStation('原宿駅に寄ります', stations, '13時新宿駅')).toBe(true);
    expect(hasUnknownStation('新宿駅に寄ります', stations, '13時新宿駅')).toBe(false);
  });
  it('どこにも無い駅名は、知らない名称として扱う', () => {
    expect(hasUnknownStation('品川駅で乗り換えます', stations, '東京駅に13時')).toBe(true);
    expect(hasUnknownStation('東京駅と新橋駅', stations, '')).toBe(true);
  });
});

describe('revisePlan（修正）', () => {
  const KEEP = errand({ id: 'e1' });
  const STOP = { ...SUPERMARKET, id: 's2' };
  /** 完成した計画を作り、修正する */
  async function revise(
    answer: Record<string, unknown>,
    request: Parameters<typeof revisePlan>[3] = { instruction: 'パンは買わなくていい' },
    now = NOW,
  ) {
    const { deps, calls, searches } = setup({ revise: intent(answer) });
    const first = await startPlan(deps, context(), INPUT);
    const before = { calls: calls.length, searches: searches.length };
    const outcome = await revisePlan({ ...deps, now: () => now }, context(), saved(first), request);
    return { outcome, calls: calls.slice(before.calls), searches: searches.slice(before.searches) };
  }

  it('取りやめた立寄りを外して作り直す。確定した場所は検索し直さない', async () => {
    const { outcome, calls, searches } = await revise(
      { errands: [KEEP], stops: [], removedIds: ['s2'] },
      {
        instruction: '買い物はやめる',
        purchaseItems: [
          { sourceId: 's2', items: ['カレーの食材'] },
          { sourceId: 's9', items: ['知らない立寄り'] },
        ],
      },
    );
    expect(outcome.status).toBe('completed');
    expect(titles(outcome)).toEqual([
      '自宅を出発',
      '電車で東京駅へ',
      '待ち合わせ',
      '電車で自宅へ',
      '帰宅',
    ]);
    expect(calls.map((c) => c.operation)).toEqual(['revise', 'decide']);
    // いまの計画（選択中のもの）と、画面が持っていた品目だけを渡す。予定は読み直さない
    expect(calls[0]?.data).toMatchObject({
      text: '買い物はやめる',
      events: [],
      current: {
        date: 'today',
        mode: 'train',
        errands: [{ id: 'e1', place: '東京駅', startTime: '13:00', endTime: '14:00' }],
        stops: [{ id: 's2', category: 'supermarket' }],
        purchaseItems: { s2: ['カレーの食材'] },
      },
    });
    expect(searches.filter((s) => s.fields === 'basic')).toEqual([]);
    expect(outcome.purchaseItems).toEqual([]);
    expect(outcome.questions).toBe(0);
    expect(outcome.draft.slots?.find((s) => s.slot === 'return_stops')?.decision).toBe(
      '立寄りはありません',
    );
  });

  it('時刻の変更と立寄りの追加。足りない終了は、質問せずに仮定で埋める', async () => {
    const { outcome } = await revise({
      // 開始だけを変え、終了は元の値（14:00）を写して返してきた
      errands: [errand({ id: 'e1', startTime: '15:00' })],
      stops: [
        { ...STOP, items: ['カレーの食材', '牛乳'] },
        { ...SUPERMARKET, category: 'drugstore', items: ['洗剤'] },
      ],
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.draft.errands[0]).toMatchObject({
      start: at('15:00'),
      end: at('16:00'),
      assumed: ['end'],
    });
    expect(outcome.assumptions).toContain('「待ち合わせ」の所要時間を 60 分と仮定しました');
    expect(outcome.draft.stops.map((s) => s.id)).toEqual(['s2', 's3']);
    expect(outcome.purchaseItems).toEqual([
      { sourceId: 's2', items: ['カレーの食材', '牛乳'] },
      { sourceId: 's3', items: ['洗剤'] },
    ]);
  });

  it('返されなかった用事・立寄りは、そのまま残す。対象日の変更は受け付けず、注意に入れる', async () => {
    const { outcome } = await revise({ date: 'tomorrow', errands: [], stops: [] });
    expect(outcome.draft.date).toBe('2026-11-25');
    expect(titles(outcome)).toContain('待ち合わせ');
    expect(titles(outcome)).toContain('サンプルスーパー自宅前店');
    expect(outcome.warnings).toEqual(['対象日は変更できません。日付はそのままで作り直しました']);
  });

  it('すでに始まっている用事が残る修正は 409（PLAN_EXPIRED）。その用事を変える・やめる修正はできる', async () => {
    const later = new Date(at('13:30'));
    await expect(
      revise({ errands: [KEEP], stops: [], removedIds: ['s2'] }, undefined, later),
    ).rejects.toMatchObject({ statusCode: 409, details: [{ field: 'PLAN_EXPIRED' }] });
    const moved = await revise(
      { errands: [errand({ id: 'e1', startTime: '16:00', endTime: '17:00' })], stops: [STOP] },
      undefined,
      later,
    );
    expect(moved.outcome.draft.errands[0]).toMatchObject({ start: at('16:00'), end: at('17:00') });
    const dropped = await revise(
      { errands: [], stops: [STOP], removedIds: ['e1'] },
      undefined,
      later,
    );
    expect(titles(dropped.outcome)).not.toContain('待ち合わせ');
  });

  it('AI が返さなかった立寄りの品目は、画面が持っていたものを返す', async () => {
    const { outcome } = await revise(
      { errands: [errand({ id: 'e1', startTime: '15:00', endTime: '16:00' })], stops: [] },
      { instruction: '15時からにして', purchaseItems: [{ sourceId: 's2', items: ['米'] }] },
    );
    expect(outcome.purchaseItems).toEqual([{ sourceId: 's2', items: ['米'] }]);
  });

  it('仮定で埋めた値を直したら、その仮定の文を消す', async () => {
    const { deps } = setup({
      interpret: intent({ errands: [errand({ endTime: null })] }),
      patch: { place: null, placeIsSpecific: true, startTime: null, endTime: null },
      revise: intent({ errands: [errand({ id: 'e1', endTime: '15:30' })], stops: [] }),
    });
    let outcome = await startPlan(deps, context(), INPUT);
    while (outcome.status === 'clarifying') {
      outcome = await answerPlan(deps, context(), saved(outcome), { answer: 'わからない' });
    }
    expect(outcome.assumptions).toEqual(['「待ち合わせ」の所要時間を 60 分と仮定しました']);
    const revised = await revisePlan(deps, context(), saved(outcome), {
      instruction: '15時半まで',
    });
    expect(revised.assumptions).toEqual([]);
    expect(revised.draft.errands[0]).toMatchObject({ end: at('15:30'), assumed: [] });
  });

  it('何も残らない修正・計画と関係のない指示は 400', async () => {
    await expect(
      revise({ errands: [], stops: [], removedIds: ['e1', 's2'] }),
    ).rejects.toMatchObject({ statusCode: 400, details: [{ field: 'instruction' }] });
    await expect(revise({ rejected: true, errands: [], stops: [] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('作り直しても計画にならなければ（店が見つからない）、400 にして何も変えない', async () => {
    const { deps } = setup({
      revise: intent({ errands: [], stops: [STOP], removedIds: ['e1'] }),
    });
    const first = await startPlan(deps, context(), INPUT);
    const plan = saved(first);
    const copy = structuredClone(plan.draft);
    const empty = { ...deps, maps: fakeMaps({ stores: () => [] }).maps };
    await expect(
      revisePlan(empty, context(), plan, { instruction: '待ち合わせはやめる' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: [{ message: '計画に入れられる用事・立寄りがありません' }],
    });
    expect(plan.draft).toEqual(copy);
  });
});

describe('removeItem（項目の削除）', () => {
  async function completed(answers: Parameters<typeof fakeAi>[0] = {}) {
    const { deps, calls, searches } = setup(answers);
    const first = await startPlan(deps, context(), INPUT);
    calls.length = 0;
    searches.length = 0;
    return { deps, calls, searches, plan: saved(first) };
  }

  it('立寄りの削除は、AI も店の検索も呼ばずに作り直す', async () => {
    const { deps, calls, searches, plan } = await completed({
      interpret: intent({ stops: [SUPERMARKET, { ...SUPERMARKET, category: 'drugstore' }] }),
    });
    const outcome = await removeItem(deps, context(), plan, 's3');
    expect(outcome.status).toBe('completed');
    expect(calls).toEqual([]);
    expect(searches).toEqual([]);
    expect(outcome.draft.stops.map((s) => s.id)).toEqual(['s2']);
    expect(titles(outcome)?.filter((t) => t.startsWith('サンプルスーパー'))).toHaveLength(1);
    expect(outcome.purchaseItems).toBeUndefined();
    expect(outcome.draft.slots?.map((s) => s.slot)).toEqual(SLOT_IDS);
  });

  it('往路の立寄りを消したら、往路の立寄りの判断文を定型文にする', async () => {
    const { deps, plan } = await completed({
      interpret: intent({ stops: [SUPERMARKET, { ...SUPERMARKET, category: 'drugstore' }] }),
      decide: () => ({
        slots: SLOT_IDS.map((slot) => ({ slot, decision: '買い物を済ませます' })),
        stopovers: [
          { stopId: 's2', candidate: 'c1', when: 'before' },
          { stopId: 's3', candidate: 'c1', when: 'after' },
        ],
      }),
    });
    const slot = (o: { slots?: { slot: string; decision: string }[] }, id: string) =>
      o.slots?.find((s) => s.slot === id)?.decision;
    expect(slot(plan.draft, 'outbound_stops')).toBe('買い物を済ませます');
    const outcome = await removeItem(deps, context(), plan, 's2');
    expect(slot(outcome.draft, 'outbound_stops')).toBe('立寄りはありません');
    expect(slot(outcome.draft, 'return_stops')).toBe('買い物を済ませます');
  });

  it('始まっている用事が残る削除は 409（PLAN_EXPIRED）', async () => {
    const { deps, plan } = await completed();
    const later = { ...deps, now: () => new Date(at('13:30')) };
    await expect(removeItem(later, context(), plan, 's2')).rejects.toMatchObject({
      statusCode: 409,
      details: [{ field: 'PLAN_EXPIRED' }],
    });
  });

  it('用事の削除は、店の候補から取り直す（AI②を呼ぶ）', async () => {
    const { deps, calls, plan } = await completed();
    const outcome = await removeItem(deps, context(), plan, 'e1');
    expect(calls.map((c) => c.operation)).toEqual(['decide']);
    expect(titles(outcome)).not.toContain('待ち合わせ');
    expect(titles(outcome)).toContain('サンプルスーパー自宅前店');
  });

  it('出発・移動・帰宅の項目と、何も残らなくなる削除は 409（NOT_DELETABLE）', async () => {
    const { deps, plan } = await completed({ interpret: intent({ stops: [] }) });
    for (const sourceId of [null, 'e1']) {
      await expect(removeItem(deps, context(), plan, sourceId)).rejects.toMatchObject({
        statusCode: 409,
        details: [{ field: 'NOT_DELETABLE' }],
      });
    }
  });
});
