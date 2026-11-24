ALTER TABLE "plan" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "plan_item" ADD COLUMN "source_id" varchar(16);