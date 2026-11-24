import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  applySelection,
  assume,
  createDraft,
  needsSelection,
  nextPending,
  reconcile,
  toClarification,
  type Draft,
  type PlanEvent,
} from '../../src/agent/draft.js';
import type { Spot } from '../../src/agent/lookup.js';
import { Interpretation } from '../../src/agent/prompts.js';

const NOW = new Date('2026-11-25T09:00:00+09:00');
const at = (time: string, date = '2026-11-25') => `${date}T${time}:00+09:00`;
const HOME = { lat: 35.64, lng: 139.67 };
const TOKYO: Spot = {
  placeId: 'p-tokyo',
  name: '東京駅',
  address: '東京都千代田区丸の内1丁目',
  location: { lat: 35.6812, lng: 139.7671 },
};

const errand = (overrides: Record<string, unknown> = {}) => ({
  id: null,
  sameAs: null,
  title: '待ち合わせ',
  kind: 'other',
  place: '東京駅',
  placeIsSpecific: true,
  startTime: '13:00',
  endTime: null,
  ...overrides,
});
const stop = (category = 'supermarket') => ({
  id: null,
  category,
  chain: null,
  perishable: false,
  items: ['カレーの食材'],
});
const intent = (overrides: Record<string, unknown> = {}) =>
  Interpretation.parse({
    rejected: false,
    date: 'today',
    mode: 'train',
    errands: [errand()],
    stops: [stop()],
    removedIds: [],
    shoppingTime: null,
    assumptions: [],
    ...overrides,
  });
const event = (ref: string, start: string, end: string, overrides: Partial<PlanEvent> = {}) => ({
  ref,
  source: ref.startsWith('c') ? ('calendar' as const) : ('routine' as const),
  date: '2026-11-25',
  title: `予定${ref}`,
  place: '新宿駅',
  start: at(start),
  end: at(end),
  ...overrides,
});
const draftOf = (i = intent(), events: PlanEvent[] = []) => createDraft(i, events, NOW);
const resolved = (draft: Draft) => {
  for (const e of draft.errands) if (e.at === 'place') e.spot = TOKYO;
  return draft;
};

describe('createDraft', () => {
  it('読み取りの結果から、ID を振って下書きを作る（品目は入れない）', () => {
    const draft = draftOf();
    expect(draft).toMatchObject({ rev: 0, date: '2026-11-25', mode: 'train', nextId: 3 });
    expect(draft.errands[0]).toMatchObject({
      id: 'e1',
      source: 'input',
      at: 'place',
      place: '東京駅',
      start: at('13:00'),
      selected: true,
    });
    expect(draft.stops).toEqual([
      { id: 's2', category: 'supermarket', chain: undefined, perishable: false, selected: true },
    ]);
    expect(JSON.stringify(draft)).not.toContain('カレー');
  });

  it('明日の計画は、明日の日付にする。終了が開始より前なら翌日', () => {
    const draft = draftOf(
      intent({ date: 'tomorrow', errands: [errand({ startTime: '23:00', endTime: '01:00' })] }),
    );
    expect(draft.date).toBe('2026-11-26');
    expect(draft.errands[0]).toMatchObject({
      start: at('23:00', '2026-11-26'),
      end: at('01:00', '2026-11-27'),
    });
  });

  it('対象日の予定だけを用事にする。場所が空・オンラインの予定は、迎え方を選んでもらう', () => {
    const draft = draftOf(intent({ errands: [] }), [
      event('c1', '10:00', '11:00'),
      event('c2', '14:00', '15:00', { place: 'https://zoom.us/j/123' }),
      event('r3', '18:00', '19:00', { place: undefined }),
      event('c4', '10:00', '11:00', { date: '2026-11-26' }),
    ]);
    expect(draft.errands.map((e) => [e.ref, e.source, e.at, e.needsPlace, e.place])).toEqual([
      ['c1', 'calendar', 'place', undefined, '新宿駅'],
      ['c2', 'calendar', 'home', true, undefined],
      ['r3', 'routine', 'home', true, undefined],
    ]);
  });

  it('入力と同じ予定は、入力の用事にまとめる（時刻は予定、場所は具体的なほう）', () => {
    const draft = draftOf(
      intent({
        errands: [
          errand({ title: '歯医者', place: '歯医者', placeIsSpecific: false, sameAs: 'c1' }),
        ],
      }),
      [event('c1', '15:00', '16:00', { place: 'さくら歯科' })],
    );
    expect(draft.errands).toHaveLength(1);
    expect(draft.errands[0]).toMatchObject({
      source: 'input',
      ref: 'c1',
      title: '歯医者',
      place: 'さくら歯科',
      specific: true,
      start: at('15:00'),
      end: at('16:00'),
      original: { place: '歯医者', specific: false, start: at('13:00') },
    });

    const specific = draftOf(intent({ errands: [errand({ sameAs: 'c1' })] }), [
      event('c1', '15:00', '16:00'),
    ]);
    expect(specific.errands[0]?.place).toBe('東京駅');
  });

  it('予定が5件あっても、いま入力した用事（時刻が無くても）は選んだままにする', () => {
    const draft = draftOf(
      intent({ errands: [errand({ startTime: null })] }),
      [10, 11, 12, 13, 14].map((h) => event(`c${h}`, `${h}:00`, `${h}:30`)),
    );
    expect(draft.errands.filter((e) => e.selected).map((e) => e.ref ?? e.id)).toEqual([
      'e1',
      'c10',
      'c11',
      'c12',
      'c13',
    ]);
  });

  it('場所が実在の施設名（Meeting Room・Teamsビル）なら、オンラインの予定として扱わない', () => {
    const draft = draftOf(intent({ errands: [] }), [
      event('c1', '10:00', '11:00', { place: 'Meeting Room 3' }),
      event('c2', '11:00', '12:00', { place: 'Teamsビル 5階' }),
      event('c3', '12:00', '13:00', { place: 'Google Meet' }),
      event('c4', '13:00', '14:00', { place: 'Teams会議' }),
    ]);
    expect(draft.errands.map((e) => e.needsPlace ?? false)).toEqual([false, false, true, true]);
  });

  it('当日の終わった予定は選ばない。6件以上なら、開始の早い5件を選ぶ', () => {
    const draft = draftOf(intent({ errands: [], stops: Array.from({ length: 7 }, () => stop()) }), [
      event('c0', '07:00', '08:00'),
      ...[10, 11, 12, 13, 14, 15].map((h) => event(`c${h}`, `${h}:00`, `${h}:30`)),
    ]);
    expect(draft.errands.filter((e) => e.selected).map((e) => e.ref)).toEqual([
      'c10',
      'c11',
      'c12',
      'c13',
      'c14',
    ]);
    expect(draft.stops.map((s) => s.selected)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('予定の件名は 40 文字に切り、URL と制御文字を除く', () => {
    const draft = draftOf(intent({ errands: [] }), [
      event('c1', '10:00', '11:00', {
        title: `会議 https://evil.example/x\u0000${'あ'.repeat(255)}`,
      }),
    ]);
    expect(draft.errands[0]?.title).toHaveLength(40);
    expect(draft.errands[0]?.title).not.toContain('example');
    expect(draft.errands[0]?.title).not.toContain('\u0000');
  });
});

describe('予定の一覧', () => {
  const events = [event('c1', '10:00', '11:00'), event('c2', '16:00', '17:00')];

  it('出す条件：用事が2件以上／立寄りが6件以上／迎え方を選ぶ予定がある', () => {
    expect(needsSelection(draftOf())).toBe(false);
    expect(needsSelection(draftOf(intent(), [events[0]!]))).toBe(true);
    expect(
      needsSelection(draftOf(intent({ stops: Array.from({ length: 6 }, () => stop()) }))),
    ).toBe(true);
    expect(
      needsSelection(
        draftOf(intent({ errands: [] }), [event('c1', '10:00', '11:00', { place: undefined })]),
      ),
    ).toBe(true);
    expect(needsSelection({ ...draftOf(intent(), events), selectionDone: true })).toBe(false);
    // 終わった（初期値で選ばない）予定の迎え方だけでは、一覧を出さない
    expect(
      needsSelection(draftOf(intent(), [event('c1', '07:00', '08:00', { place: undefined })])),
    ).toBe(false);
  });

  it('選んだものだけを残す。一覧に無い ID・0件・6件以上は 400', () => {
    const draft = draftOf(intent(), events);
    applySelection(draft, { selectedIds: ['e2', 's4'] });
    expect(draft.errands.map((e) => e.selected)).toEqual([false, true, false]);
    expect(draft.selectionDone).toBe(true);

    expect(() => applySelection(draftOf(intent(), events), { selectedIds: ['x9'] })).toThrow();
    expect(() => applySelection(draftOf(intent(), events), { selectedIds: [] })).toThrow();
    const many = draftOf(
      intent({ errands: [] }),
      [10, 11, 12, 13, 14, 15].map((h) => event(`c${h}`, `${h}:00`, `${h}:30`)),
    );
    expect(() => applySelection(many, { selectedIds: many.errands.map((e) => e.id) })).toThrow();
  });

  it('迎え方：指定が無ければ自宅で。場所を入力したら、その場所へ行く用事になる', () => {
    const online = (place?: string) =>
      draftOf(intent({ errands: [] }), [
        event('c1', '10:00', '11:00', { place }),
        event('c2', '12:00', '13:00', { place: undefined }),
      ]);
    const draft = online();
    applySelection(draft, {
      selectedIds: ['e1', 'e2'],
      places: [{ id: 'e2', at: 'place', text: '渋谷ヒカリエ' }],
    });
    expect(draft.errands.map((e) => [e.at, e.place, e.needsPlace])).toEqual([
      ['home', undefined, undefined],
      ['place', '渋谷ヒカリエ', undefined],
    ]);

    const stay = online();
    applySelection(stay, { selectedIds: ['e1', 'e2'], places: [{ id: 'e2', at: 'stay' }] });
    expect(stay.errands[1]?.at).toBe('stay');
    // 場所の入力が無い・迎え方を選べない予定への指定は 400
    expect(() =>
      applySelection(online(), { selectedIds: ['e1'], places: [{ id: 'e1', at: 'place' }] }),
    ).toThrow();
    expect(() =>
      applySelection(online('新宿駅'), { selectedIds: ['e1'], places: [{ id: 'e1', at: 'home' }] }),
    ).toThrow();
  });

  it('「いったん帰宅する」は、3時間以上の空きだけを受け付ける（合わない指定は無視）', () => {
    const draft = draftOf(intent({ errands: [], stops: [] }), [
      event('c1', '09:00', '10:00'),
      event('c2', '13:00', '14:00'),
      event('c3', '16:00', '17:00'),
    ]);
    applySelection(draft, {
      selectedIds: ['e1', 'e2', 'e3'],
      homeBetween: ['e1', 'e2', 'e3', 'x'],
    });
    expect(draft.homeBetween).toEqual(['e1']);
    // 選ばなかった用事をはさむ空きは、選んだものだけで計算する
    const skipped = draftOf(intent({ errands: [], stops: [] }), [
      event('c1', '09:00', '10:00'),
      event('c2', '11:00', '12:00'),
      event('c3', '13:00', '14:00'),
    ]);
    applySelection(skipped, { selectedIds: ['e1', 'e3'], homeBetween: ['e1'] });
    expect(skipped.homeBetween).toEqual(['e1']);
  });

  it('一覧の応答：用事（開始の順）と立寄り、選べる件数。終了の無い用事は仮に 60 分', () => {
    const draft = draftOf(intent(), [event('c1', '10:00', '11:00')]);
    draft.pending = { kind: 'selection', question: '計画に入れる予定を選んでください' };
    draft.rev = 1;
    const clarification = toClarification(draft, 0);
    expect(clarification).toMatchObject({
      kind: 'selection',
      token: 1,
      count: 0,
      maxCount: 2,
      allowFreeText: false,
      limits: { maxErrands: 5, maxStops: 5, minTotal: 1, gapMinutes: 180 },
    });
    expect(clarification?.options).toEqual([
      {
        id: 'e2',
        group: 'errand',
        label: '予定c1',
        detail: '新宿駅',
        source: 'calendar',
        startTime: at('10:00'),
        endTime: at('11:00'),
        selected: true,
        needsPlace: undefined,
      },
      {
        id: 'e1',
        group: 'errand',
        label: '待ち合わせ',
        detail: '東京駅',
        source: 'input',
        startTime: at('13:00'),
        endTime: at('14:00'),
        selected: true,
        needsPlace: undefined,
      },
      { id: 's3', group: 'stop', label: 'スーパー', selected: true },
    ]);
  });
});

describe('確認質問', () => {
  it('不足が無ければ質問しない。食事は 60 分、飲み会は 2 時間を既定にする', () => {
    const draft = resolved(
      draftOf(
        intent({
          errands: [
            errand({ kind: 'meal' }),
            errand({ kind: 'party', startTime: '18:00' }),
            errand({ endTime: '15:00', startTime: '14:30' }),
          ],
        }),
      ),
    );
    expect(nextPending(draft, new Map(), NOW)).toBeUndefined();
    expect(draft.errands.map((e) => e.end)).toEqual([at('14:00'), at('20:00'), at('15:00')]);
  });

  it('1つの用事の不足をまとめて、定型の文で聞く。開始の早い用事から', () => {
    const draft = resolved(
      draftOf(
        intent({
          errands: [
            errand({ title: '打ち合わせ', startTime: '15:00' }),
            errand({ title: '通院', place: null, startTime: '10:00' }),
          ],
        }),
      ),
    );
    delete draft.errands[1]?.spot;
    expect(nextPending(draft, new Map(), NOW)).toEqual({
      kind: 'question',
      errandId: 'e2',
      missing: ['place', 'end'],
      question: '「通院」について、場所と、何時ごろまでかを教えてください',
    });
  });

  it('場所が1つに決まらない用事は、候補から選んでもらう', () => {
    const draft = draftOf(
      intent({ errands: [errand({ title: '歯医者', place: '歯医者', placeIsSpecific: false })] }),
    );
    expect(nextPending(draft, new Map([['e1', [TOKYO]]]), NOW)).toEqual({
      kind: 'place',
      errandId: 'e1',
      question: '「歯医者」の場所はどちらですか？',
      options: [{ id: 'p1', ...TOKYO }],
    });
  });

  it('当日の入力の用事で、開始が過ぎていれば、時刻を聞き直す（予定は聞き直さない）', () => {
    const draft = resolved(
      draftOf(intent({ errands: [errand({ startTime: '08:00', endTime: '08:30' })] }), [
        event('c1', '07:00', '08:00'),
      ]),
    );
    draft.errands[1]!.selected = true;
    expect(nextPending(draft, new Map(), NOW)).toMatchObject({
      errandId: 'e1',
      missing: ['start'],
      question: '「待ち合わせ」の開始の時刻（08:00）は過ぎています。開始の時刻を教えてください',
    });
  });

  it('回答の差分を反映する。場所が変われば、確定した場所を捨てる', () => {
    const draft = resolved(draftOf());
    applyPatch(draft, 'e1', {
      place: null,
      placeIsSpecific: true,
      startTime: null,
      endTime: '14:30',
    });
    expect(draft.errands[0]).toMatchObject({ end: at('14:30'), spot: TOKYO, id: 'e1' });

    applyPatch(draft, 'e1', {
      place: '品川駅',
      placeIsSpecific: true,
      startTime: '15:00',
      endTime: null,
    });
    expect(draft.errands[0]).toMatchObject({ place: '品川駅', start: at('15:00') });
    expect(draft.errands[0]?.spot).toBeUndefined();
    // 開始が終了より後になったら、終了は聞き直す
    expect(draft.errands[0]?.end).toBeUndefined();
  });

  it('開始だけを答えたとき、AI が元の終了を写して返しても、翌日の終了にしない', () => {
    const draft = resolved(draftOf(intent({ errands: [errand({ endTime: '14:00' })] })));
    applyPatch(draft, 'e1', {
      place: null,
      placeIsSpecific: true,
      startTime: '16:00',
      endTime: '14:00',
    });
    expect(draft.errands[0]?.start).toBe(at('16:00'));
    expect(draft.errands[0]?.end).toBeUndefined();
    // 終了も答えたときは、そのまま使う（日をまたぐ指定は翌日）
    applyPatch(draft, 'e1', {
      place: null,
      placeIsSpecific: true,
      startTime: '23:00',
      endTime: '01:00',
    });
    expect(draft.errands[0]?.end).toBe(at('01:00', '2026-11-26'));
  });

  it('自宅のすぐ近くとして自宅扱いにした用事も、場所を答え直したら検索し直す', () => {
    const draft = resolved(draftOf());
    draft.errands[0]!.at = 'home';
    applyPatch(draft, 'e1', {
      place: '渋谷ヒカリエ',
      placeIsSpecific: true,
      startTime: null,
      endTime: null,
    });
    expect(draft.errands[0]).toMatchObject({ at: 'place', place: '渋谷ヒカリエ' });
  });

  it('飲み会は、開始だけを聞く（終了は 2 時間の既定で決まる）。仮定でも 2 時間にする', () => {
    const draft = resolved(
      draftOf(intent({ errands: [errand({ kind: 'party', startTime: null })] })),
    );
    expect(nextPending(draft, new Map(), NOW)).toMatchObject({ missing: ['start'] });
    assume(draft, new Map(), NOW, HOME);
    expect(draft.errands[0]).toMatchObject({ start: at('11:00'), end: at('13:00') });
  });

  it('深夜の仮定は、対象日を越えない（23:30 にする）', () => {
    const draft = resolved(draftOf(intent({ errands: [errand({ startTime: null })] })));
    assume(draft, new Map(), new Date(at('22:40')), HOME);
    expect(draft.errands[0]?.start).toBe(at('23:30'));
  });

  it('上限に達したら、仮定で埋める（今日は2時間後を30分単位に切り上げ、所要 60 分）', () => {
    const draft = draftOf(
      intent({
        errands: [
          errand({ title: '歯医者', place: '歯医者', placeIsSpecific: false, startTime: null }),
          errand({ title: '場所の無い用事', place: null }),
        ],
      }),
    );
    const far: Spot = { ...TOKYO, name: '遠い歯科', location: { lat: 43.06, lng: 141.35 } };
    const near: Spot = { ...TOKYO, name: 'さくら歯科' };
    const warnings = assume(draft, new Map([['e1', [far, near]]]), new Date(at('09:10')), HOME);
    expect(draft.errands[0]).toMatchObject({
      spot: near,
      start: at('11:30'),
      end: at('12:30'),
      assumed: ['place', 'start', 'end'],
    });
    expect(draft.assumptions).toEqual([
      '「歯医者」の場所を「さくら歯科」と仮定しました',
      '「歯医者」の開始を 11:30 と仮定しました',
      '「歯医者」の所要時間を 60 分と仮定しました',
    ]);
    // 場所が決まらない用事は外す
    expect(draft.errands[1]?.selected).toBe(false);
    expect(warnings).toEqual([
      '「場所の無い用事」は、場所が決まらなかったため、計画から外しました',
    ]);
    expect(nextPending(draft, new Map(), NOW)).toBeUndefined();
  });

  it('明日の計画の仮定は、開始 10:00', () => {
    const draft = resolved(
      draftOf(intent({ date: 'tomorrow', errands: [errand({ startTime: null })] })),
    );
    assume(draft, new Map(), NOW, HOME);
    expect(draft.errands[0]).toMatchObject({ start: at('10:00', '2026-11-26') });
  });
});

describe('reconcile（設定の変更での見直し）', () => {
  const build = () =>
    draftOf(intent({ errands: [errand({ sameAs: 'c1' })] }), [
      event('c1', '15:00', '16:00'),
      event('c2', '17:00', '18:00'),
      event('r3', '19:00', '20:00'),
      event('r4', '21:00', '22:00'),
    ]);

  /** カレンダーの同意と、いま有効なルーティン */
  const settings = (calendar: boolean, routines: string[]) => ({
    user: { calendarUsageConsent: calendar } as Parameters<typeof reconcile>[1]['user'],
    events: routines.map((ref) => event(ref, '19:00', '20:00')),
  });

  it('確認の対象の用事・帰宅の指定に使った用事が落ちたら、確認と指定も片付ける', () => {
    const draft = build();
    draft.homeBetween = ['e1', 'e2'];
    draft.pending = { kind: 'place', errandId: 'e2', question: '「予定c2」の場所はどちらですか？' };
    reconcile(draft, settings(false, ['r3', 'r4']));
    expect(draft.homeBetween).toEqual(['e1']);
    expect(draft.pending).toEqual({
      kind: 'question',
      question: '予定の設定が変わりました。回答すると、続きから計画を作ります',
    });
  });

  it('回答で入れた値は、予定が使えなくなっても残す', () => {
    const draft = build();
    applyPatch(draft, 'e1', {
      place: '恵比寿歯科',
      placeIsSpecific: true,
      startTime: '17:00',
      endTime: '18:00',
    });
    reconcile(draft, settings(false, []));
    expect(draft.errands[0]).toMatchObject({
      place: '恵比寿歯科',
      start: at('17:00'),
      end: at('18:00'),
    });
  });

  it('使える予定は、そのまま残す', () => {
    const draft = build();
    reconcile(draft, settings(true, ['r3', 'r4']));
    expect(draft.errands).toHaveLength(4);
  });

  it('カレンダーの同意が OFF なら、カレンダーの予定を落とし、まとめた用事は入力の値に戻す', () => {
    const draft = build();
    draft.errands[0]!.spot = TOKYO;
    reconcile(draft, settings(false, ['r3']));
    expect(draft.errands.map((e) => e.ref)).toEqual([undefined, 'r3']);
    expect(draft.errands[0]).toMatchObject({ start: at('13:00'), place: '東京駅', spot: TOKYO });
    expect(draft.errands[0]?.end).toBeUndefined();
    expect(draft.errands[0]?.original).toBeUndefined();
  });
});
