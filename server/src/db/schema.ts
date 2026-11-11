/**
 * DB スキーマ定義。正は docs/design/DB定義書.md（PostgreSQL 版）。
 * 変更したら `npm run db:generate` で server/drizzle/ に SQL を作り、
 * 取り消し用の SQL を server/drizzle/down/ に同じ名前で手書きする。
 * カラム名は camelCase で書き、DB では snake_case になる（drizzle.config.ts の casing）。
 * 問い合わせに使うときも drizzle(client, { casing: 'snake_case' }) を指定すること。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  time,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

/** 利用者の識別子（Cognito の sub） */
const userIdType = () => varchar({ length: 64 });
const id = () => integer().primaryKey().generatedAlwaysAsIdentity();
const timestamptz = () => timestamp({ withTimezone: true });
const createdAt = () => timestamptz().notNull().defaultNow();
/** 更新日時。Drizzle 経由の更新では自動で現在時刻になる（DB のトリガーは使わない） */
const updatedAt = () =>
  timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export interface FrequentlyUsedStation {
  stationCode: string;
  stationName: string;
  label: string;
}

export interface RouteDetail {
  distanceMeters?: number;
  durationMinutes?: number;
  fareYen?: number;
  polyline?: string;
  steps?: unknown[];
}

export interface PlanItemStore {
  placeId: string;
  name: string;
  address?: string;
  pointProgramCode?: string;
}

export const user = pgTable(
  'user',
  {
    id: userIdType().primaryKey(),
    homeAddress: varchar({ length: 255 }),
    homeLatitude: doublePrecision(),
    homeLongitude: doublePrecision(),
    frequentlyUsedStations: jsonb().$type<FrequentlyUsedStation[]>().notNull().default([]),
    walkingSpeed: varchar({ length: 10 }).notNull().default('normal'),
    preparationTimeMinutes: integer().notNull().default(30),
    priorityCondition: varchar({ length: 20 }).notNull().default('on_time'),
    memoUsageConsent: boolean().notNull().default(false),
    locationUsageConsent: boolean().notNull().default(false),
    calendarUsageConsent: boolean().notNull().default(false),
    notificationEnabled: boolean().notNull().default(false),
    onboardingCompleted: boolean().notNull().default(false),
    termsAcceptedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('ck_user_walking_speed', sql`${t.walkingSpeed} in ('slow', 'normal', 'fast')`),
    check('ck_user_preparation_time_minutes', sql`${t.preparationTimeMinutes} between 0 and 180`),
    check(
      'ck_user_priority_condition',
      sql`${t.priorityCondition} in ('on_time', 'save_money', 'points')`,
    ),
  ],
);

export const plan = pgTable(
  'plan',
  {
    id: id(),
    userId: userIdType().notNull(),
    inputText: varchar({ length: 500 }).notNull(),
    targetDate: date().notNull(),
    departureTime: timestamptz(),
    returnTime: timestamptz(),
    status: varchar({ length: 20 }).notNull().default('generating'),
    clarificationCount: integer().notNull().default(0),
    clarificationQuestion: varchar({ length: 255 }),
    assumptions: jsonb().$type<string[]>().notNull().default([]),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_plan_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    index('idx_plan_user_id_created_at').on(t.userId, t.createdAt),
    check('ck_plan_status', sql`${t.status} in ('generating', 'clarifying', 'completed', 'error')`),
    check('ck_plan_clarification_count', sql`${t.clarificationCount} between 0 and 2`),
  ],
);

export const planItem = pgTable(
  'plan_item',
  {
    id: id(),
    planId: integer().notNull(),
    sequence: integer().notNull(),
    slotType: varchar({ length: 20 }).notNull(),
    itemType: varchar({ length: 20 }).notNull(),
    title: varchar({ length: 100 }).notNull(),
    startTime: timestamptz().notNull(),
    endTime: timestamptz().notNull(),
    locationName: varchar({ length: 255 }),
    locationLatitude: doublePrecision(),
    locationLongitude: doublePrecision(),
    transportMode: varchar({ length: 10 }),
    routeDetail: jsonb().$type<RouteDetail>(),
    store: jsonb().$type<PlanItemStore>(),
    stationExit: varchar({ length: 255 }),
    boardingPosition: varchar({ length: 255 }),
    description: varchar({ length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_plan_item_plan_id',
      columns: [t.planId],
      foreignColumns: [plan.id],
    }).onDelete('cascade'),
    index('idx_plan_item_plan_id_sequence').on(t.planId, t.sequence),
    check(
      'ck_plan_item_slot_type',
      sql`${t.slotType} in ('DEPARTURE', 'OUTBOUND', 'MAIN', 'RETURN')`,
    ),
    check(
      'ck_plan_item_item_type',
      sql`${t.itemType} in ('departure', 'move', 'stopover', 'errand', 'meal', 'return')`,
    ),
    check(
      'ck_plan_item_transport_mode',
      sql`${t.transportMode} in ('walk', 'bicycle', 'car', 'train')`,
    ),
  ],
);

export const slotEvaluation = pgTable(
  'slot_evaluation',
  {
    id: id(),
    planId: integer().notNull(),
    slotType: varchar({ length: 20 }).notNull(),
    slotName: varchar({ length: 255 }).notNull(),
    evaluationOrder: integer().notNull(),
    isEvaluated: boolean().notNull(),
    evaluationResult: varchar({ length: 1000 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_slot_evaluation_plan_id',
      columns: [t.planId],
      foreignColumns: [plan.id],
    }).onDelete('cascade'),
    index('idx_slot_evaluation_plan_id_evaluation_order').on(t.planId, t.evaluationOrder),
    check(
      'ck_slot_evaluation_slot_type',
      sql`${t.slotType} in ('DEPARTURE', 'OUTBOUND', 'MAIN', 'RETURN')`,
    ),
  ],
);

export const agentSession = pgTable(
  'agent_session',
  {
    id: id(),
    planId: integer().notNull(),
    sessionType: varchar({ length: 20 }).notNull(),
    inputSummary: varchar({ length: 1000 }).notNull(),
    outputSummary: varchar({ length: 1000 }).notNull(),
    judgmentResult: varchar({ length: 1000 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_agent_session_plan_id',
      columns: [t.planId],
      foreignColumns: [plan.id],
    }).onDelete('cascade'),
    index('idx_agent_session_plan_id').on(t.planId),
    check(
      'ck_agent_session_session_type',
      sql`${t.sessionType} in ('intent', 'clarify', 'compose', 'replan')`,
    ),
  ],
);

export const routine = pgTable(
  'routine',
  {
    id: id(),
    userId: userIdType().notNull(),
    routineName: varchar({ length: 255 }).notNull(),
    locationName: varchar({ length: 255 }),
    startTime: time(),
    endTime: time(),
    /** 単発スキップした日（日本時間）。今日と同じなら「今日はスキップ」 */
    skippedDate: date(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_routine_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    index('idx_routine_user_id').on(t.userId),
    // 片方だけ NULL だと比較結果が不明（NULL）になり CHECK を通ってしまうので、両方あることも確かめる
    check(
      'ck_routine_time_range',
      sql`(${t.startTime} is null and ${t.endTime} is null) or (${t.startTime} is not null and ${t.endTime} is not null and ${t.startTime} < ${t.endTime})`,
    ),
  ],
);

export const memo = pgTable(
  'memo',
  {
    id: id(),
    userId: userIdType().notNull(),
    memoText: varchar({ length: 255 }).notNull(),
    checkedLines: jsonb().$type<number[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_memo_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    index('idx_memo_user_id_created_at').on(t.userId, t.createdAt),
    index('idx_memo_created_at').on(t.createdAt),
  ],
);

export const calendarIntegration = pgTable(
  'calendar_integration',
  {
    id: id(),
    userId: userIdType().notNull(),
    provider: varchar({ length: 10 }).notNull(),
    status: varchar({ length: 20 }).notNull().default('connected'),
    /** Secrets Manager の名前。API には出さない */
    secretName: varchar({ length: 255 }).notNull(),
    scope: varchar({ length: 255 }),
    connectedAt: timestamptz().notNull().defaultNow(),
    lastSyncedAt: timestamptz(),
    lastError: varchar({ length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_calendar_integration_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    unique('uq_calendar_integration_user_id_provider').on(t.userId, t.provider),
    check('ck_calendar_integration_provider', sql`${t.provider} in ('google', 'outlook')`),
    check('ck_calendar_integration_status', sql`${t.status} in ('connected', 'error')`),
  ],
);

export const calendarEvent = pgTable(
  'calendar_event',
  {
    id: id(),
    userId: userIdType().notNull(),
    calendarIntegrationId: integer().notNull(),
    externalEventId: varchar({ length: 255 }).notNull(),
    eventTitle: varchar({ length: 255 }).notNull(),
    eventDate: date().notNull(),
    isAllDay: boolean().notNull().default(false),
    startTime: timestamptz().notNull(),
    endTime: timestamptz().notNull(),
    location: varchar({ length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_calendar_event_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_calendar_event_calendar_integration_id',
      columns: [t.calendarIntegrationId],
      foreignColumns: [calendarIntegration.id],
    }).onDelete('cascade'),
    index('idx_calendar_event_user_id').on(t.userId),
    unique('uq_calendar_event_integration_external').on(
      t.calendarIntegrationId,
      t.externalEventId,
      t.eventDate,
    ),
  ],
);

export const departureLog = pgTable(
  'departure_log',
  {
    id: id(),
    userId: userIdType().notNull(),
    planId: integer().notNull(),
    plannedDepartureTime: timestamptz().notNull(),
    actualDepartureTime: timestamptz().notNull(),
    preparationTimeMinutes: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_departure_log_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_departure_log_plan_id',
      columns: [t.planId],
      foreignColumns: [plan.id],
    }).onDelete('cascade'),
    index('idx_departure_log_user_id').on(t.userId),
    index('idx_departure_log_plan_id').on(t.planId),
  ],
);

export const pointProgram = pgTable(
  'point_program',
  {
    id: id(),
    userId: userIdType().notNull(),
    programCode: varchar({ length: 10 }).notNull(),
    isEnabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'fk_point_program_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    unique('uq_point_program_user_id_program_code').on(t.userId, t.programCode),
    check(
      'ck_point_program_program_code',
      sql`${t.programCode} in ('rakuten', 'vpoint', 'dpoint', 'ponta', 'waon', 'nanaco')`,
    ),
  ],
);

/** 利用者×日付ごとの計画生成回数（計画を消しても回数は戻さない） */
export const generationQuota = pgTable(
  'generation_quota',
  {
    userId: userIdType().notNull(),
    quotaDate: date().notNull(),
    usedCount: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'pk_generation_quota', columns: [t.userId, t.quotaDate] }),
    foreignKey({
      name: 'fk_generation_quota_user_id',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
  ],
);
