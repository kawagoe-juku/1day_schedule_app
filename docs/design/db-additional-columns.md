# DB定義の追加カラム一覧と判断事項（WBS 2.11 案）

- 作成：2026-10-26（Claude 案）／承認：未
- 対象：`docs/Alli/DB定義書.txt`（11テーブル）と `api/openapi.yaml`（v0.2.x）の差分
- 承認後、PostgreSQL 版の DB 定義書を `docs/design/DB定義書.md` として作成し、DDL（WBS 2.9）はこれを正とする。原本（`docs/Alli/`）は変更しない。

## 1. 判断が必要な事項

| # | 論点 | 案 | 理由 | 承認 |
| --- | --- | --- | --- | --- |
| D1 | DBMS と型の読み替え（U2） | PostgreSQL 16（Aurora）。`INT`→`integer`（主キーは `integer GENERATED ALWAYS AS IDENTITY`）、`DATETIME`→`timestamptz`、`TINYINT(1)`→`boolean`、`JSON`→`jsonb`、`DOUBLE`→`double precision`、`VARCHAR(n)`→`varchar(n)`。文字コード・照合順序・エンジンの記載は削除 | 要件の Aurora PostgreSQL に合わせる。時刻はタイムゾーン付きで保存し、表示時に日本時間へ変換する | |
| D2 | ユーザーの識別子（U3） | `user.id` は **Cognito の sub（`varchar(64)`）を主キー**にする。他テーブルの `user_id` も同じ型。`cognito_user_id` 列は廃止（`id` と同じになるため） | エンティティ定義の回答（2026-08-31）で「user_id は Cognito sub に統一」と決定済み。JWT の sub でそのまま引ける | |
| D3 | email を DB に持つか | **持たない**。プロファイル取得時は JWT（ID トークン）の email を返す | 正本は Cognito。二重管理による不一致と、個人情報の保存箇所を減らす | |
| D4 | 論理削除と退会（U4） | 退会は**物理削除**（要件どおり）。`user` の `is_deleted`・`deleted_at` は廃止。子テーブルは `ON DELETE CASCADE` に変更し、退会時に一括削除 | 論理削除のままだと退会後も個人情報が残り、要件と矛盾する | |
| D5 | 他テーブルの論理削除 | `plan`・`plan_item`・`memo`・`routine` などの `is_deleted`・`deleted_at` も**廃止**し、削除は物理削除。監査が必要な `slot_evaluation`・`agent_session` は計画の削除に合わせて CASCADE | API に「削除済みを見る」機能がなく、論理削除の条件漏れによる不具合を避ける | |
| D6 | 作成者・更新者列 | `created_by_user_id`・`updated_by_user_id` は**廃止** | 本人以外が更新する経路がなく、常に `user_id` と同じになる | |
| D7 | 移動手段「バス」 | `transport_mode` の選択肢から**削除**（徒歩・自転車・車・電車の4種） | API 仕様（TransportMode）で「バス・タクシーは対象外」と決定済み | |
| D8 | 選択肢の値 | 日本語（'遅い' 等）ではなく、API と同じ英字コード（`slow`/`normal`/`fast` 等）で保存し、CHECK 制約を付ける | API 仕様の決定（2026-10-15）に合わせ、変換処理をなくす | |
| D9 | ルーティンの単発スキップ（U5） | `is_skipped` を廃止し、`skipped_date date`（スキップした日。日本時間）を追加。`skippedToday` は「`skipped_date` = 今日」で判定 | `is_skipped` では翌日に自動で解除できない | |
| D10 | 生成回数の保存先（U6） | 新しいテーブル `generation_quota`（利用者×日付ごとの回数）を追加（2.11） | 13秒打ち切り（502）は数えないなど、計画の件数とは一致しない。計画を物理削除しても回数が戻らないよう、計画とは別に持つ | |
| D11 | カレンダー連携のトークン | `access_token_secret_arn`・`refresh_token_secret_arn`・`token_expires_at`・`external_account_id` を廃止し、`secret_name` 1列に集約 | エンティティ定義の回答（2026-08-31）で決定済み | |

## 2. 追加・変更するカラム

凡例：**追加**／**変更**／**削除**。共通の `created_at`・`updated_at`（`timestamptz NOT NULL DEFAULT now()`）は全テーブルに残す。

### 2.1 user

| 区分 | カラム | 型 | NULL | 既定値 | 内容・API 項目 |
| --- | --- | --- | --- | --- | --- |
| 変更 | id | varchar(64) | NO | - | Cognito sub（主キー）。D2 |
| 削除 | cognito_user_id, email | - | - | - | D2・D3 |
| 変更 | home_address, home_latitude, home_longitude | 同左 | **YES** | NULL | オンボーディング完了前は未設定のため（API の homeAddress・homeLocation は null 可） |
| 変更 | frequently_used_stations | jsonb | NO | `'[]'` | `[{ stationCode, stationName, label }]`、最大20件 |
| 変更 | walking_speed | varchar(10) | NO | `'normal'` | CHECK: slow / normal / fast |
| 変更 | preparation_time_minutes | integer | NO | 30 | 0〜180（U12 の案：30分） |
| 変更 | priority_condition | varchar(20) | NO | `'on_time'` | CHECK: on_time / save_money / points |
| 変更 | 同意・通知の4列 | boolean | NO | false | |
| **追加** | onboarding_completed | boolean | NO | false | onboardingCompleted |
| **追加** | terms_accepted_at | timestamptz | YES | NULL | termsAcceptedAt（利用規約への同意日時） |
| 削除 | created_by_user_id, updated_by_user_id, is_deleted, deleted_at | - | - | - | D4・D6 |

### 2.2 plan

| 区分 | カラム | 型 | NULL | 既定値 | 内容・API 項目 |
| --- | --- | --- | --- | --- | --- |
| **追加** | target_date | date | NO | - | targetDate（計画の対象日・日本時間） |
| 変更 | departure_time, return_time | timestamptz | **YES** | NULL | 生成中・確認質問中は未確定のため |
| 変更 | status | varchar(20) | NO | `'generating'` | CHECK: generating / clarifying / completed / error |
| 変更 | clarification_count | integer | NO | 0 | CHECK 0〜2 |
| **追加** | clarification_question | varchar(255) | YES | NULL | clarification.question（確認質問中のみ） |
| **追加** | assumptions | jsonb | NO | `'[]'` | assumptions（仮定した内容の文字列配列） |
| **追加** | warnings | jsonb | NO | `'[]'` | warnings（注意の文字列配列） |
| 削除 | created_by_user_id, updated_by_user_id, is_deleted, deleted_at | - | - | - | D5・D6 |

インデックス：`idx_plan_user_id_created_at (user_id, created_at)`（履歴表示用）に置き換える。

### 2.3 plan_item

| 区分 | カラム | 型 | NULL | 既定値 | 内容・API 項目 |
| --- | --- | --- | --- | --- | --- |
| **追加** | slot_type | varchar(20) | NO | - | slotType。CHECK: DEPARTURE / OUTBOUND / MAIN / RETURN |
| 変更 | item_type | varchar(20) | NO | - | CHECK: departure / move / stopover / errand / meal / return |
| **追加** | title | varchar(100) | NO | - | title（タイムラインの見出し） |
| 変更 | description | varchar(500) | YES | NULL | 詳細説明。255 では乗換の説明が収まらないため拡張 |
| 変更 | transport_mode | varchar(10) | YES | NULL | CHECK: walk / bicycle / car / train。D7 |
| 変更 | route_detail | jsonb | YES | NULL | `{ distanceMeters, durationMinutes, fareYen, polyline, steps[] }`。運賃（fare）はここに含める |
| **追加** | store | jsonb | YES | NULL | `{ placeId, name, address, pointProgramCode }`（立寄り先の店舗。openNow は保存しない） |
| 削除 | created_by_user_id, updated_by_user_id, is_deleted, deleted_at | - | - | - | D5・D6 |

`purchaseItems`（買う品目）は API の説明どおり DB に保存しない。

### 2.4 slot_evaluation／agent_session

| 区分 | 内容 |
| --- | --- |
| 変更 | `slot_type` の CHECK はそのまま。`session_type` は英字コード（intent / clarify / compose / replan）に変更。D8 |
| 変更 | `evaluation_result`・`input_summary`・`output_summary`・`judgment_result` を varchar(1000) に拡張（AI の判断理由が 255 字を超えるため） |
| 削除 | 作成者・更新者・論理削除の4列。外部キーは `ON DELETE CASCADE`。D5・D6 |

### 2.5 routine

| 区分 | カラム | 型 | NULL | 既定値 | 内容・API 項目 |
| --- | --- | --- | --- | --- | --- |
| 変更 | start_time, end_time | **time** | YES | NULL | API は時刻のみ（TimeOfDay）。CHECK：両方 NULL または start < end |
| 削除 | is_skipped | - | - | - | D9 |
| **追加** | skipped_date | date | YES | NULL | skippedToday の判定用。D9 |
| 削除 | 作成者・更新者・論理削除の4列 | - | - | - | D5・D6 |

### 2.6 memo

| 区分 | 内容 |
| --- | --- |
| 変更 | `checked_lines` は jsonb、NOT NULL、既定値 `'[]'` |
| 削除 | 作成者・更新者・論理削除の4列（自動削除バッチも物理削除）。D5・D6 |

### 2.7 calendar_integration

| 区分 | カラム | 型 | NULL | 既定値 | 内容・API 項目 |
| --- | --- | --- | --- | --- | --- |
| 変更 | provider | varchar(10) | NO | - | CHECK: google / outlook |
| **追加** | status | varchar(20) | NO | `'connected'` | status。CHECK: connected / error（未連携は行なし＝not_connected） |
| **追加** | secret_name | varchar(255) | NO | - | Secrets Manager の名前（例：`integration/{user_id}/google`）。API には出さない |
| **追加** | scope | varchar(255) | YES | NULL | 許可されたスコープ |
| **追加** | connected_at | timestamptz | NO | now() | connectedAt |
| **追加** | last_synced_at | timestamptz | YES | NULL | lastSyncedAt |
| **追加** | last_error | varchar(255) | YES | NULL | 直近のエラー（内部用） |
| 削除 | external_account_id, access_token_secret_arn, refresh_token_secret_arn, token_expires_at, is_active | - | - | - | D11（解除時は行を削除） |
| 削除 | 作成者・更新者・論理削除の4列 | - | - | - | D5・D6 |

### 2.8 calendar_event

| 区分 | 内容 |
| --- | --- |
| **追加** | `event_date date NOT NULL`（当日分のみ保持・削除バッチ用）、`is_all_day boolean NOT NULL DEFAULT false`（終日予定） |
| 変更 | 外部キー `calendar_integration_id` は `ON DELETE CASCADE`（連携解除で予定キャッシュも削除） |
| 削除 | 作成者・更新者・論理削除の4列 |

### 2.9 departure_log

Web 版では出発検知を行わない（準備のみ）ため、テーブルは定義書どおり作成し、型の読み替えと共通列の削除（D1・D5・D6）だけを行う。

### 2.10 point_program

| 区分 | カラム | 型 | NULL | 既定値 | 内容・API 項目 |
| --- | --- | --- | --- | --- | --- |
| **追加** | program_code | varchar(10) | NO | - | programCode。CHECK: rakuten / vpoint / dpoint / ponta / waon / nanaco |
| 削除 | program_name, store_chain | - | - | - | 名称と店舗チェーンは共通の対応表（WBS 5.11 の設定ファイル）から引く。利用者ごとに持たない |
| 変更 | is_enabled | boolean | NO | true | |
| 追加 | 一意制約 `uq_point_program_user_id_program_code (user_id, program_code)` | | | | 同じプログラムを二重登録しない |

### 2.11 generation_quota（新規テーブル）

| カラム | 型 | NULL | 既定値 | 内容 |
| --- | --- | --- | --- | --- |
| user_id | varchar(64) | NO | - | FOREIGN KEY → user.id（ON DELETE CASCADE） |
| quota_date | date | NO | - | 日本時間の日付 |
| used_count | integer | NO | 0 | その日に数えた生成回数（上限20。超えたら 429） |
| updated_at | timestamptz | NO | now() | |

主キーは `(user_id, quota_date)`。どの API を数えるか（createPlan のみか）は WBS 5.9 で確定する（U6）。古い日付の行は日次バッチで削除する。

## 3. 一意制約・インデックスの追加

| テーブル | 追加 | 理由 |
| --- | --- | --- |
| plan | `idx_plan_user_id_created_at (user_id, created_at)` | 履歴表示 |
| memo | `idx_memo_created_at (created_at)` | 自動削除バッチ（作成から1週間）の範囲検索。既存の `(user_id, created_at)` は残す |
| calendar_event | `uq_calendar_event_integration_external (calendar_integration_id, external_event_id, event_date)` | 同じ予定の重複キャッシュを防ぐ |
| point_program | `uq_point_program_user_id_program_code` | 上記 2.10 |

## 4. 承認後の作業

1. 前田さんの承認（表の「承認」欄、または一括承認）
2. Claude が `docs/design/DB定義書.md`（PostgreSQL 版）と詳細設計書の ER 図を更新
3. WBS 2.9 で Drizzle のスキーマとマイグレーションを作成
