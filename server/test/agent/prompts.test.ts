import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  decideCall,
  Decisions,
  ErrandPatch,
  interpretCall,
  Interpretation,
  patchCall,
} from '../../src/agent/prompts.js';
import { matchesTemplate, SLOT_IDS, SLOTS } from '../../src/agent/slots.js';
import { pointProgramOf } from '../../src/agent/point-chains.js';

const errand = {
  id: null,
  sameAs: null,
  title: '待ち合わせ',
  kind: 'other',
  place: '東京駅',
  placeIsSpecific: true,
  startTime: '13:00',
  endTime: null,
};
const interpretation = {
  rejected: false,
  date: 'today',
  mode: 'train',
  errands: [errand],
  stops: [
    {
      id: null,
      category: 'supermarket',
      chain: null,
      perishable: true,
      items: ['カレーの食材', '排水口のネット'],
    },
  ],
  removedIds: [],
  shoppingTime: null,
  assumptions: [],
};

describe('Interpretation（読み取りの出力）', () => {
  it('正しい出力を受け入れる', () => {
    expect(Interpretation.parse(interpretation)).toEqual(interpretation);
  });

  it('上限を超えた件数・文字数は、切り詰めて受け入れる', () => {
    const parsed = Interpretation.parse({
      ...interpretation,
      errands: Array.from({ length: 7 }, () => ({ ...errand, title: 'あ'.repeat(60) })),
      stops: Array.from({ length: 12 }, () => interpretation.stops[0]),
      assumptions: ['い'.repeat(100), '', 'a', 'b', 'c'],
    });
    expect(parsed.errands).toHaveLength(5);
    expect(parsed.errands[0]?.title).toHaveLength(40);
    expect(parsed.stops).toHaveLength(10);
    expect(parsed.assumptions).toEqual(['い'.repeat(80), 'a', 'b']);
  });

  it('時刻は HH:mm だけを受け入れる', () => {
    const withTime = (startTime: string) => ({
      ...interpretation,
      errands: [{ ...errand, startTime }],
    });
    expect(Interpretation.safeParse(withTime('09:05')).success).toBe(true);
    expect(Interpretation.safeParse(withTime('9:05')).success).toBe(false);
    expect(Interpretation.safeParse(withTime('24:00')).success).toBe(false);
    expect(Interpretation.safeParse(withTime('13時')).success).toBe(false);
  });

  it('URL などを取り除いて空になった場所・チェーン名は null、件名は定型にする', () => {
    const parsed = Interpretation.parse({
      ...interpretation,
      errands: [{ ...errand, title: 'https://a.example', place: 'http://a.example' }],
      stops: [{ ...interpretation.stops[0], chain: ' ' }],
    });
    expect(parsed.errands[0]).toMatchObject({ title: '用事', place: null });
    expect(parsed.stops[0]?.chain).toBeNull();
  });

  it('ID は決まった形だけを受け入れる（長い文字列・URL・制御文字は不合格）', () => {
    const withId = (id: string) => ({ ...interpretation, errands: [{ ...errand, id }] });
    expect(Interpretation.safeParse(withId('e12')).success).toBe(true);
    expect(Interpretation.safeParse(withId('a'.repeat(33))).success).toBe(false);
    expect(Interpretation.safeParse(withId('https://evil.example/')).success).toBe(false);
    expect(Interpretation.safeParse({ ...interpretation, removedIds: ['e1\u0000'] }).success).toBe(
      false,
    );
  });

  it('件名・場所・品目・仮定から URL を取り除く', () => {
    const parsed = Interpretation.parse({
      ...interpretation,
      errands: [{ ...errand, title: '会議 https://evil.example/x', place: 'http://a.example' }],
      assumptions: ['詳細は https://evil.example を参照'],
    });
    expect(JSON.stringify(parsed)).not.toContain('example');
  });
});

describe('Decisions（判断の出力）', () => {
  const decisions = {
    slots: SLOT_IDS.map((slot) => ({ slot, decision: '問題なし' })),
    stopovers: [{ stopId: 's1', candidate: 'c2', when: 'after' }],
  };

  it('正しい出力を受け入れ、テンプレートと一致する', () => {
    const parsed = Decisions.parse(decisions);
    expect(matchesTemplate(parsed.slots)).toBe(true);
  });

  it('知らないスロットは受け入れない', () => {
    const slots = [...decisions.slots.slice(1), { slot: 'unknown', decision: 'x' }];
    expect(Decisions.safeParse({ ...decisions, slots }).success).toBe(false);
  });

  it('判断文は 40 文字に切り詰める', () => {
    const slots = decisions.slots.map((s) => ({ ...s, decision: 'あ'.repeat(50) }));
    expect(Decisions.parse({ ...decisions, slots }).slots[0]?.decision).toHaveLength(40);
  });
});

describe('matchesTemplate', () => {
  const all = SLOT_IDS.map((slot) => ({ slot }));

  it('評価の順番は MAIN → OUTBOUND → DEPARTURE → RETURN', () => {
    const types = SLOTS.map((slot) => slot.type).filter((t, i, list) => t !== list[i - 1]);
    expect(types).toEqual(['MAIN', 'OUTBOUND', 'DEPARTURE', 'RETURN']);
  });

  it('スロットが欠けている・順番が違う・余分がある・重複しているものは一致しない', () => {
    expect(matchesTemplate(all)).toBe(true);
    expect(matchesTemplate([all[0]!, all[0]!, ...all.slice(2)])).toBe(false);
    expect(matchesTemplate(all.slice(1))).toBe(false);
    expect(matchesTemplate([all[1]!, all[0]!, ...all.slice(2)])).toBe(false);
    expect(matchesTemplate([...all, all[0]!])).toBe(false);
    expect(matchesTemplate([])).toBe(false);
  });
});

describe('AI の呼び出しの定義', () => {
  const calls = [
    interpretCall({ now: '2026-11-20T10:00:00+09:00', text: '入力文の中身', events: [] }),
    patchCall({ now: '2026-11-20T10:00:00+09:00', errand, question: 'q', answer: '回答の中身' }),
    decideCall({ errands: [errand], note: 'データの中身' }),
  ];

  it('利用者由来の文字列は data にだけ入り、system には入らない', () => {
    for (const call of calls) {
      expect(call.system).not.toMatch(/入力文の中身|回答の中身|データの中身/);
      expect(JSON.stringify(call.data)).toMatch(/入力文の中身|回答の中身|データの中身/);
    }
  });

  it('出力の形から、ツールの定義（JSON Schema）を作れる', () => {
    for (const call of calls) {
      const schema = z.toJSONSchema(call.schema, { io: 'input' });
      expect(schema).toMatchObject({ type: 'object' });
    }
  });

  it('判断の指示は、テンプレートの全スロットを順番どおりに挙げる', () => {
    const system = calls[2]!.system;
    const positions = SLOT_IDS.map((id) => system.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('修正のときは、呼び出しの種類が revise になる', () => {
    const call = interpretCall({
      now: '2026-11-20T10:00:00+09:00',
      text: 'パンは買わなくていい',
      events: [],
      current: { errands: [], stops: [] },
    });
    expect(call.operation).toBe('revise');
  });

  it('差分の出力は、場所と時刻だけ', () => {
    expect(Object.keys(ErrandPatch.shape).sort()).toEqual(
      ['endTime', 'place', 'placeIsSpecific', 'startTime'].sort(),
    );
  });
});

describe('pointProgramOf（ポイントの対象店舗の判定）', () => {
  it('店名にチェーン名が含まれていれば、そのポイントを返す', () => {
    expect(pointProgramOf('ローソン 三軒茶屋駅前店', ['ponta'])).toBe('ponta');
    expect(pointProgramOf('イオンスタイル碑文谷', ['waon', 'nanaco'])).toBe('waon');
  });

  it('表記のゆれ（空白・ハイフン）があっても判定できる', () => {
    expect(pointProgramOf('セブン‐イレブン 世田谷太子堂店', ['nanaco'])).toBe('nanaco');
    expect(pointProgramOf('セブン-イレブン世田谷太子堂店', ['nanaco'])).toBe('nanaco');
    expect(pointProgramOf('マツモト キヨシ 三軒茶屋店', ['dpoint'])).toBe('dpoint');
  });

  it('ハイフンの種類・全角半角が違っても判定できる', () => {
    for (const name of ['セブン−イレブン', 'セブン–イレブン', 'セブンーイレブン', 'ｾﾌﾞﾝ-ｲﾚﾌﾞﾝ']) {
      expect(pointProgramOf(`${name} 太子堂店`, ['nanaco'])).toBe('nanaco');
    }
  });

  it('チェーン名を一部に含むだけの別の店は、対象にしない', () => {
    expect(pointProgramOf('銀座ライオン 新宿店', ['waon'])).toBeUndefined();
    expect(pointProgramOf('イオンシネマ板橋', ['waon'])).toBeUndefined();
    expect(pointProgramOf('ライフォート 三宮店', ['dpoint'])).toBeUndefined();
    expect(pointProgramOf('ココスナカムラ 竹の塚店', ['ponta'])).toBeUndefined();
    expect(pointProgramOf('ガストロパブ渋谷', ['dpoint'])).toBeUndefined();
    // 正しい店は対象のまま
    expect(pointProgramOf('ライフ 太子堂店', ['dpoint'])).toBe('dpoint');
    expect(pointProgramOf('ナチュラルローソン 渋谷店', ['ponta'])).toBe('ponta');
    expect(pointProgramOf('イオンモール幕張新都心', ['waon'])).toBe('waon');
  });

  it('有効にしていないポイントの店・対象外の店は undefined', () => {
    expect(pointProgramOf('ローソン 三軒茶屋駅前店', ['nanaco'])).toBeUndefined();
    expect(pointProgramOf('サンプルスーパー', ['rakuten', 'vpoint', 'dpoint'])).toBeUndefined();
    expect(pointProgramOf('ローソン', [])).toBeUndefined();
  });

  it('複数のポイントが対象なら、指定した順で最初のものを返す', () => {
    expect(pointProgramOf('ファミリーマート 駒沢店', ['dpoint', 'rakuten'])).toBe('dpoint');
    expect(pointProgramOf('ファミリーマート 駒沢店', ['rakuten', 'dpoint'])).toBe('rakuten');
  });
});
