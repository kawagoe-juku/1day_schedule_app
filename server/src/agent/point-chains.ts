/**
 * ポイントプログラムと、そのポイントが貯まる主な店舗チェーンの対応表（WBS 5.11）。
 * 店舗の優先選定で、店名にチェーン名が含まれるかどうかで判定する。
 *
 * 【内容は案】提携は変わることがあるので、公開前に各社の公式情報で確かめること。
 * 追加・削除は、この表を書き換えるだけでよい。
 */
import type { PointProgramCode } from '../db/repositories/point-program-repository.js';

export const POINT_CHAINS: Record<PointProgramCode, readonly string[]> = {
  rakuten: [
    'ファミリーマート',
    'ツルハドラッグ',
    'サンドラッグ',
    'ダイコクドラッグ',
    'くすりの福太郎',
    'マクドナルド',
    'ミスタードーナツ',
    'くら寿司',
    'すき家',
    'ガスト',
    'バーミヤン',
    'ジョナサン',
  ],
  vpoint: [
    'ファミリーマート',
    'ウエルシア',
    'ハックドラッグ',
    'マルエツ',
    '東武ストア',
    'ガスト',
    'バーミヤン',
    'ジョナサン',
    '吉野家',
    'ドトール',
    'エクセルシオール',
  ],
  dpoint: [
    'ローソン',
    'ファミリーマート',
    'マツモトキヨシ',
    'ココカラファイン',
    'ライフ',
    '東急ストア',
    'マクドナルド',
    'ミスタードーナツ',
    'ガスト',
    'バーミヤン',
    'ジョナサン',
    'すき家',
  ],
  ponta: [
    'ローソン',
    'ナチュラルローソン',
    'ローソンストア100',
    '成城石井',
    'ケンタッキー',
    'すき家',
    '大戸屋',
    'はま寿司',
    'ココス',
  ],
  waon: [
    'イオン',
    'イオンスタイル',
    'イオンモール',
    'マックスバリュ',
    'まいばすけっと',
    'ダイエー',
    'ピーコックストア',
    'ミニストップ',
    'ウエルシア',
    'ハックドラッグ',
  ],
  nanaco: ['セブン-イレブン', 'イトーヨーカドー', 'ヨークマート', 'ヨークフーズ', 'デニーズ'],
};

/** 表記のゆれ（全角半角・空白・ハイフンの種類）をそろえる */
const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/\s/g, '')
    .replace(/[-‐‑‒–—―−]/g, 'ー');

/**
 * チェーン名が、店名の中に「ひとまとまりの語」として現れるか。
 * 前後がカタカナで続くものは別の語なので除く（「イオン」と「銀座ライオン」、「ライフ」と「ライフォート」）
 */
const matchers = new Map<string, RegExp>();
function hasChain(name: string, chain: string): boolean {
  let matcher = matchers.get(chain);
  if (!matcher) {
    const escaped = normalize(chain).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matcher = new RegExp(`(?<![ァ-ヶー])${escaped}(?![ァ-ヶー])`);
    matchers.set(chain, matcher);
  }
  return matcher.test(name);
}

/**
 * 店名から、有効なポイントプログラムのうち対象になるものを返す（複数あれば programs の順で最初のもの）。
 * 対象でなければ undefined。
 */
export function pointProgramOf(
  storeName: string,
  programs: readonly PointProgramCode[],
): PointProgramCode | undefined {
  const name = normalize(storeName);
  return programs.find((code) => POINT_CHAINS[code].some((chain) => hasChain(name, chain)));
}
