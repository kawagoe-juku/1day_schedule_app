-- 0000_init の取り消し：全テーブルを削除する（データも消える）
DROP TABLE
  "generation_quota",
  "point_program",
  "departure_log",
  "calendar_event",
  "calendar_integration",
  "memo",
  "routine",
  "agent_session",
  "slot_evaluation",
  "plan_item",
  "plan",
  "user";
