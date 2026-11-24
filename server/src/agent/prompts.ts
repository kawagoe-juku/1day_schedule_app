/**
 * AI への指示（system）と、出力の形。
 * AI を呼ぶのは「読み取り」（入力文 → 用事・立寄り）と「判断」（スロットの評価と店の選択）の2種類。
 * 時刻の計算と行動項目の組み立ては、AI にさせない（プログラムが行う）。
 */
import { z } from 'zod';
import { aiText, type AiCall } from './ai.js';
import { matchesTemplate, SLOT_IDS, SLOTS } from './slots.js';

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable();

/** 用事・立寄り・候補の ID（e1・s2・c3 など）。AI が書いた値でも、この形でなければ受け入れない */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
/** AI が書く文字列で、空でもよい項目。URL などを取り除いた結果が空なら null にする */
const optionalText = (maxLength: number) =>
  aiText(maxLength)
    .nullable()
    .transform((value) => value || null);

export const STORE_CATEGORIES = [
  'supermarket',
  'drugstore',
  'convenience',
  'home_center',
  'bakery',
  'restaurant',
  'other',
] as const;

/** 仮定の文（最大3件、各80文字） */
const assumptions = z
  .array(aiText(80))
  .transform((list) => list.filter((text) => text !== '').slice(0, 3));

const Errand = z.object({
  /** 修正のとき、下書きにある用事ならその ID */
  id: id.nullable(),
  /** 同じ予定（カレンダー・ルーティン）の ID */
  sameAs: id.nullable(),
  title: aiText(40).transform((value) => value || '用事'),
  kind: z.enum(['meal', 'party', 'other']),
  place: optionalText(100),
  /** 固有の場所か（「歯医者」「カフェ」のような一般名詞は false） */
  placeIsSpecific: z.boolean(),
  startTime: time,
  endTime: time,
});

const Stop = z.object({
  id: id.nullable(),
  category: z.enum(STORE_CATEGORIES),
  /** 店のチェーン名の指定（「マツキヨで」など）。無ければ null */
  chain: optionalText(40),
  /** 生鮮品・冷蔵品を含む */
  perishable: z.boolean(),
  items: z.array(aiText(40)).transform((list) => list.filter((text) => text !== '').slice(0, 20)),
});

/** 読み取り・修正の出力 */
export const Interpretation = z.object({
  rejected: z.boolean(),
  date: z.enum(['today', 'tomorrow', 'other']),
  mode: z.enum(['train', 'walk', 'bicycle', 'car']),
  errands: z.array(Errand).transform((list) => list.slice(0, 5)),
  stops: z.array(Stop).transform((list) => list.slice(0, 10)),
  removedIds: z.array(id).transform((list) => list.slice(0, 20)),
  shoppingTime: time,
  assumptions,
});
export type Interpretation = z.infer<typeof Interpretation>;

/** 差分の読み取り（確認への自由入力の回答）の出力 */
export const ErrandPatch = Errand.pick({
  place: true,
  placeIsSpecific: true,
  startTime: true,
  endTime: true,
});
export type ErrandPatch = z.infer<typeof ErrandPatch>;

/** 判断の出力 */
export const Decisions = z.object({
  /** テンプレートの全スロットを、決めた順番どおりに（欠落・重複・順序違いは不合格） */
  slots: z
    .array(z.object({ slot: z.enum(SLOT_IDS), decision: aiText(40) }))
    .refine(matchesTemplate, 'slots must match the template'),
  stopovers: z.array(
    z.object({
      stopId: id,
      /** 候補の番号（c1, c2…） */
      candidate: id,
      when: z.enum(['before', 'after']),
    }),
  ),
});
export type Decisions = z.infer<typeof Decisions>;

/** その日の予定（カレンダー・ルーティン）。AI には「データ」として渡す */
export interface DayEvent {
  id: string;
  date: 'today' | 'tomorrow';
  title: string;
  place?: string;
  start: string;
  end: string;
}

export interface InterpretInput {
  /** 現在の日時（日本時間、ISO 8601） */
  now: string;
  /** 入力文（POST）、または修正指示（revise） */
  text: string;
  /** メモの行（同意ONのみ。POST のときだけ） */
  memos?: string[];
  events: DayEvent[];
  /** 修正のとき：いまの下書き（ID 付き）と、画面が持っている品目 */
  current?: { errands: unknown[]; stops: unknown[]; purchaseItems?: Record<string, string[]> };
}

const INTERPRET_SYSTEM = `あなたは、外出の計画を作るための「読み取り係」です。<data> の text（利用者の入力文）から、外出の用事と買い物を読み取り、submit_interpretation で提出します。

# 読み取り方
- errands：場所と時刻のある用事（待ち合わせ、通院、打ち合わせ、飲み会など）。書かれていない場所・時刻は推測せず null にします。
- placeIsSpecific：場所が固有の名称（駅名、施設名、店名、住所）なら true。「歯医者」「カフェ」「会社」のような一般名詞は false。
- kind：食事の予定は meal、飲み会・宴会は party、それ以外は other。
- stops：時刻の決まっていない買い物・食事。買う店の種類ごとに1件にまとめ、items に品目を入れます。memos があれば、そこに書かれた買う物も含めます。
- perishable：生鮮品・冷蔵品・冷凍品を含むなら true。
- date：today か tomorrow。それ以外の日（明後日、来週など）は other。日付が書かれていなければ today。
- mode：移動手段の指定が無ければ train。
- errands に入れるのは、text に書かれた用事だけです。events（その日にすでに入っている予定）は参考の情報で、errands には入れません。text の用事が events のどれかと同じ予定のときだけ、その用事の sameAs に events の id を入れます。
- id は、current が無いときは必ず null にします。
- shoppingTime：用事が無く買い物だけで、出かける時刻が書かれているときだけ入れます。
- title は 40 文字以内、place は 100 文字以内。stops は 10 件まで、errands は 5 件まで。
- rejected：外出の計画と関係のない入力、不適切な入力なら true（ほかの項目は空にします）。
- assumptions：日付・時刻・場所のあいまいな表現（「夕方」「いつもの店」など）を解釈したときだけ、どう解釈したかを書きます。それ以外は空にします。買い物の内容・品目名・店の種類の選び方は書きません。

# 修正のとき（current があるとき）
- text は、いまの計画（current）への修正指示です。current の用事・立寄りのうち、残すものは id を付けて返します。
- 取りやめるものは、removedIds に id を入れます。新しく加わるものは id を null にします。
- current.purchaseItems は、いま買う予定の品目です。修正を反映した品目を items に入れます。`;

const PATCH_SYSTEM = `あなたは、外出の計画を作るための「読み取り係」です。<data> の errand（用事）について、question（確認の質問）への answer（利用者の回答）から分かったことを、submit_patch で提出します。

- 回答から分かった項目だけを埋め、分からない項目は errand の値のままにします（無ければ null）。
- placeIsSpecific：場所が固有の名称（駅名、施設名、店名、住所）なら true。
- 時刻は HH:mm（24時間制）。`;

const DECIDE_SYSTEM = `あなたは、外出の計画を作るための「判断係」です。<data> の用事（errands）・買い物（stops）・店の候補（candidates）・その日の条件を見て、submit_decisions で提出します。時刻の計算はしません。

# slots
次の ${SLOTS.length} 項目を、この順番で、1つも省かずに評価します。decision は 40 文字以内の1文で、品目名・店名・駅名は書かず、「買い物」「生鮮品」などの種別で書きます。
${SLOTS.map((slot, index) => `${index + 1}. ${slot.id}（${slot.name}）：${slot.guide}`).join('\n')}

# stopovers
- stops の1件ごとに、candidates からその stop の候補を1つ選び、番号（c1 など）を candidate に入れます。候補が無い stop は入れません。
- when：候補の場所（anchor）の用事の前に寄るなら before、後なら after。anchor が home のときは、出発してすぐが before、帰宅の直前が after。
- perishable が true の買い物は、できるだけ帰宅に近いところで寄ります。
- priority が points のときは、ポイントの対象（point がある候補）を選びます。save_money のときは近い店、on_time のときは用事に遅れない位置を選びます。`;

/** 読み取り・修正（AI①） */
export const interpretCall = (data: InterpretInput): AiCall<Interpretation> => ({
  operation: data.current ? 'revise' : 'interpret',
  system: INTERPRET_SYSTEM,
  data,
  tool: {
    name: 'submit_interpretation',
    description: '入力文から読み取った用事と買い物を提出する',
  },
  schema: Interpretation,
  // 用事5件・立寄り10件・品目が多い入力でも、途中で切れない大きさ
  maxTokens: 1500,
  timeoutMs: 3500,
});

/** 差分の読み取り（AI①） */
export const patchCall = (data: {
  now: string;
  errand: unknown;
  question: string;
  answer: string;
}): AiCall<ErrandPatch> => ({
  operation: 'patch',
  system: PATCH_SYSTEM,
  data,
  tool: { name: 'submit_patch', description: '回答から分かった、用事の場所と時刻を提出する' },
  schema: ErrandPatch,
  maxTokens: 300,
  timeoutMs: 3500,
});

/** 判断（AI②） */
export const decideCall = (data: unknown): AiCall<Decisions> => ({
  operation: 'decide',
  system: DECIDE_SYSTEM,
  data,
  tool: { name: 'submit_decisions', description: 'スロットごとの判断と、立寄り先の選択を提出する' },
  schema: Decisions,
  maxTokens: 1000,
  timeoutMs: 5000,
});
