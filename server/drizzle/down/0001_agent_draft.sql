-- 0001_agent_draft の取り消し：計画の下書きと、行動項目の元の ID を削除する（中のデータも消える）
ALTER TABLE "plan_item" DROP COLUMN "source_id";
ALTER TABLE "plan" DROP COLUMN "draft";
