/**
 * 行動計画のスロット（検討すべき項目）のテンプレート。
 * 検討する項目と順番はプログラムが決め、AI は各項目の判断だけを返す（AI は検討を省略できない）。
 * 評価の順番は MAIN → OUTBOUND → DEPARTURE → RETURN（要件定義書「AI評価順序」）。
 */
export type SlotType = 'MAIN' | 'OUTBOUND' | 'DEPARTURE' | 'RETURN';

export const SLOTS = [
  { id: 'main_errands', type: 'MAIN', name: '用事', guide: '用事どうしの時間の重なりと余裕' },
  {
    id: 'main_between',
    type: 'MAIN',
    name: '用事の間の移動・立寄り',
    guide: '用事の間の移動に無理が無いか。用事の間に寄る店',
  },
  {
    id: 'outbound_stops',
    type: 'OUTBOUND',
    name: '往路の立寄り',
    guide: '最初の用事より前に寄る店',
  },
  { id: 'outbound_move', type: 'OUTBOUND', name: '往路の移動', guide: '最初の用事に間に合うか' },
  { id: 'departure', type: 'DEPARTURE', name: '出発時刻', guide: '準備時間を踏まえた注意' },
  {
    id: 'return_stops',
    type: 'RETURN',
    name: '復路の立寄り',
    guide: '最後の用事より後に寄る店（生鮮品・冷蔵品は復路に回す）',
  },
  { id: 'return_move', type: 'RETURN', name: '復路の移動・帰宅', guide: '帰宅についての注意' },
] as const satisfies readonly { id: string; type: SlotType; name: string; guide: string }[];

export type SlotId = (typeof SLOTS)[number]['id'];
export const SLOT_IDS = SLOTS.map((slot) => slot.id) as [SlotId, ...SlotId[]];

/** AI の評価が、テンプレートの全スロットを、決めた順番どおりに含んでいるか */
export const matchesTemplate = (slots: readonly { slot: string }[]): boolean =>
  slots.length === SLOT_IDS.length && slots.every((s, index) => s.slot === SLOT_IDS[index]);
