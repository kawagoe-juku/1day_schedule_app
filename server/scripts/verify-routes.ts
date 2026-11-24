/**
 * 実際の NAVITIME で、経路の取得と計画の組み立てを確かめる手動のスクリプト。自動テストでは動かさない。
 *
 *   1. 並列の制限：乗換の検索を同時に VERIFY_PARALLEL 回（既定 6）呼び、429 などで失敗しないか
 *   2. 組み立て：用事2件（東京駅・新宿駅）の計画を作り、かかった時間と結果を表示する
 *
 * 実行：npm run verify:routes（リポジトリのルートで）。server/.env の NAVITIME_RAPIDAPI_KEY を使う。
 * NAVITIME を 9 回ほど呼ぶ（月の枠を消費する）。Google Maps は呼ばない（立寄りは入れない）。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExternalApiCall } from '../src/adapters/metrics.js';
import { createNavitimeClient } from '../src/adapters/navitime.js';
import { composePlan } from '../src/agent/compose.js';
import { createTravel } from '../src/agent/lookup.js';

const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const print = (line: string) => void process.stdout.write(`${line}\n`);
const apiKey = process.env.NAVITIME_RAPIDAPI_KEY;
if (!apiKey) {
  print('NAVITIME_RAPIDAPI_KEY が未設定です（server/.env）');
  process.exit(1);
}

const PARALLEL = Number(process.env.VERIFY_PARALLEL ?? 6);
const HOME = { lat: 35.6437, lng: 139.6713 }; // 三軒茶屋駅付近
const TOKYO = { lat: 35.6812, lng: 139.7671 };
const SHINJUKU = { lat: 35.6896, lng: 139.7006 };

const calls: ExternalApiCall[] = [];
// 計画生成で使う設定（タイムアウト 2.5 秒・リトライなし）
const navitime = createNavitimeClient({
  apiKey,
  timeoutMs: 2500,
  retries: 0,
  metrics: { record: (call) => calls.push(call) },
});

/** 明日の日付（日本時間） */
const date = new Date(Date.now() + (9 + 24) * 3600_000).toISOString().slice(0, 10);
const at = (time: string) => new Date(`${date}T${time}:00+09:00`);
const hhmm = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(11, 16);
const summary = () => {
  const done = calls.splice(0);
  const times = done.map((c) => Math.round(c.durationMs)).sort((a, b) => a - b);
  const failed = done.filter((c) => c.outcome !== 'success').map((c) => c.outcome);
  return `${done.length} 回、失敗 ${failed.length} 回${failed.length ? `（${failed.join('・')}）` : ''}、所要 ${times[0]}〜${times.at(-1)}ms`;
};

let failed = false;

print(`## 並列の制限（同時に ${PARALLEL} 回）`);
const started = performance.now();
const results = await Promise.allSettled(
  Array.from({ length: PARALLEL }, (_, i) =>
    navitime.searchTransitRoutes({
      start: HOME,
      goal: i % 2 ? TOKYO : SHINJUKU,
      arriveBy: at(`${10 + i}:00`),
    }),
  ),
);
const rejected = results.filter((r) => r.status === 'rejected');
print(`- ${summary()}、全体 ${Math.round(performance.now() - started)}ms`);
for (const r of rejected) print(`- 失敗：${(r.reason as Error).message}`);
if (rejected.length > 0) failed = true;

print('\n## 組み立て（自宅 → 東京駅 13:00 → 新宿駅 16:00 → 自宅）');
const composeStarted = performance.now();
const plan = await composePlan(
  {
    now: new Date(),
    date,
    home: HOME,
    mode: 'train',
    errands: [
      {
        id: 'e1',
        title: '待ち合わせ',
        kind: 'other',
        at: 'place',
        name: '東京駅',
        location: TOKYO,
        start: at('13:00'),
        end: at('14:00'),
      },
      {
        id: 'e2',
        title: '打ち合わせ',
        kind: 'other',
        at: 'place',
        name: '新宿駅',
        location: SHINJUKU,
        start: at('16:00'),
        end: at('17:00'),
      },
    ],
    stops: [],
    homeBetween: [],
    preparationMinutes: 30,
    priority: 'on_time',
  },
  createTravel({ navitime }, { walkingSpeed: 'normal', priority: 'on_time' }),
);
print(`- NAVITIME：${summary()}、組み立て全体 ${Math.round(performance.now() - composeStarted)}ms`);
for (const item of plan.items) {
  const detail = [
    item.route?.fareYen !== undefined && `${item.route.fareYen}円`,
    item.stationExit && `出口：${item.stationExit}`,
    item.boardingPosition && `乗車位置：${item.boardingPosition}`,
    item.route?.steps.map((s) => s.lineName ?? s.instruction).join(' → '),
  ].filter(Boolean);
  print(
    `- ${hhmm(item.start)}〜${hhmm(item.end)} ${item.title}${detail.length ? `（${detail.join('／')}）` : ''}`,
  );
}
for (const warning of plan.warnings) print(`- 注意：${warning}`);
if (plan.warnings.length > 0) failed = true;

print(failed ? '\n結果：問題あり' : '\n結果：OK');
process.exit(failed ? 1 : 0);
