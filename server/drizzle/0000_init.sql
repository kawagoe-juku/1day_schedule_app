CREATE TABLE "agent_session" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_session_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plan_id" integer NOT NULL,
	"session_type" varchar(20) NOT NULL,
	"input_summary" varchar(1000) NOT NULL,
	"output_summary" varchar(1000) NOT NULL,
	"judgment_result" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_session_session_type" CHECK ("agent_session"."session_type" in ('intent', 'clarify', 'compose', 'replan'))
);
--> statement-breakpoint
CREATE TABLE "calendar_event" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calendar_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar(64) NOT NULL,
	"calendar_integration_id" integer NOT NULL,
	"external_event_id" varchar(255) NOT NULL,
	"event_title" varchar(255) NOT NULL,
	"event_date" date NOT NULL,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"location" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_calendar_event_integration_external" UNIQUE("calendar_integration_id","external_event_id","event_date")
);
--> statement-breakpoint
CREATE TABLE "calendar_integration" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calendar_integration_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar(64) NOT NULL,
	"provider" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'connected' NOT NULL,
	"secret_name" varchar(255) NOT NULL,
	"scope" varchar(255),
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_calendar_integration_user_id_provider" UNIQUE("user_id","provider"),
	CONSTRAINT "ck_calendar_integration_provider" CHECK ("calendar_integration"."provider" in ('google', 'outlook')),
	CONSTRAINT "ck_calendar_integration_status" CHECK ("calendar_integration"."status" in ('connected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "departure_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "departure_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar(64) NOT NULL,
	"plan_id" integer NOT NULL,
	"planned_departure_time" timestamp with time zone NOT NULL,
	"actual_departure_time" timestamp with time zone NOT NULL,
	"preparation_time_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_quota" (
	"user_id" varchar(64) NOT NULL,
	"quota_date" date NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_generation_quota" PRIMARY KEY("user_id","quota_date")
);
--> statement-breakpoint
CREATE TABLE "memo" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memo_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar(64) NOT NULL,
	"memo_text" varchar(255) NOT NULL,
	"checked_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plan_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar(64) NOT NULL,
	"input_text" varchar(500) NOT NULL,
	"target_date" date NOT NULL,
	"departure_time" timestamp with time zone,
	"return_time" timestamp with time zone,
	"status" varchar(20) DEFAULT 'generating' NOT NULL,
	"clarification_count" integer DEFAULT 0 NOT NULL,
	"clarification_question" varchar(255),
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_plan_status" CHECK ("plan"."status" in ('generating', 'clarifying', 'completed', 'error')),
	CONSTRAINT "ck_plan_clarification_count" CHECK ("plan"."clarification_count" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "plan_item" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plan_item_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plan_id" integer NOT NULL,
	"sequence" integer NOT NULL,
	"slot_type" varchar(20) NOT NULL,
	"item_type" varchar(20) NOT NULL,
	"title" varchar(100) NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"location_name" varchar(255),
	"location_latitude" double precision,
	"location_longitude" double precision,
	"transport_mode" varchar(10),
	"route_detail" jsonb,
	"store" jsonb,
	"station_exit" varchar(255),
	"boarding_position" varchar(255),
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_plan_item_slot_type" CHECK ("plan_item"."slot_type" in ('DEPARTURE', 'OUTBOUND', 'MAIN', 'RETURN')),
	CONSTRAINT "ck_plan_item_item_type" CHECK ("plan_item"."item_type" in ('departure', 'move', 'stopover', 'errand', 'meal', 'return')),
	CONSTRAINT "ck_plan_item_transport_mode" CHECK ("plan_item"."transport_mode" in ('walk', 'bicycle', 'car', 'train'))
);
--> statement-breakpoint
CREATE TABLE "point_program" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "point_program_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar(64) NOT NULL,
	"program_code" varchar(10) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_point_program_user_id_program_code" UNIQUE("user_id","program_code"),
	CONSTRAINT "ck_point_program_program_code" CHECK ("point_program"."program_code" in ('rakuten', 'vpoint', 'dpoint', 'ponta', 'waon', 'nanaco'))
);
--> statement-breakpoint
CREATE TABLE "routine" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "routine_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar(64) NOT NULL,
	"routine_name" varchar(255) NOT NULL,
	"location_name" varchar(255),
	"start_time" time,
	"end_time" time,
	"skipped_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_routine_time_range" CHECK (("routine"."start_time" is null and "routine"."end_time" is null) or ("routine"."start_time" is not null and "routine"."end_time" is not null and "routine"."start_time" < "routine"."end_time"))
);
--> statement-breakpoint
CREATE TABLE "slot_evaluation" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "slot_evaluation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"plan_id" integer NOT NULL,
	"slot_type" varchar(20) NOT NULL,
	"slot_name" varchar(255) NOT NULL,
	"evaluation_order" integer NOT NULL,
	"is_evaluated" boolean NOT NULL,
	"evaluation_result" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_slot_evaluation_slot_type" CHECK ("slot_evaluation"."slot_type" in ('DEPARTURE', 'OUTBOUND', 'MAIN', 'RETURN'))
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"home_address" varchar(255),
	"home_latitude" double precision,
	"home_longitude" double precision,
	"frequently_used_stations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"walking_speed" varchar(10) DEFAULT 'normal' NOT NULL,
	"preparation_time_minutes" integer DEFAULT 30 NOT NULL,
	"priority_condition" varchar(20) DEFAULT 'on_time' NOT NULL,
	"memo_usage_consent" boolean DEFAULT false NOT NULL,
	"location_usage_consent" boolean DEFAULT false NOT NULL,
	"calendar_usage_consent" boolean DEFAULT false NOT NULL,
	"notification_enabled" boolean DEFAULT false NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"terms_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_user_walking_speed" CHECK ("user"."walking_speed" in ('slow', 'normal', 'fast')),
	CONSTRAINT "ck_user_preparation_time_minutes" CHECK ("user"."preparation_time_minutes" between 0 and 180),
	CONSTRAINT "ck_user_priority_condition" CHECK ("user"."priority_condition" in ('on_time', 'save_money', 'points'))
);
--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "fk_agent_session_plan_id" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "fk_calendar_event_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "fk_calendar_event_calendar_integration_id" FOREIGN KEY ("calendar_integration_id") REFERENCES "public"."calendar_integration"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_integration" ADD CONSTRAINT "fk_calendar_integration_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departure_log" ADD CONSTRAINT "fk_departure_log_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departure_log" ADD CONSTRAINT "fk_departure_log_plan_id" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_quota" ADD CONSTRAINT "fk_generation_quota_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memo" ADD CONSTRAINT "fk_memo_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "fk_plan_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_item" ADD CONSTRAINT "fk_plan_item_plan_id" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_program" ADD CONSTRAINT "fk_point_program_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine" ADD CONSTRAINT "fk_routine_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_evaluation" ADD CONSTRAINT "fk_slot_evaluation_plan_id" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_session_plan_id" ON "agent_session" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_event_user_id" ON "calendar_event" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_departure_log_user_id" ON "departure_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_departure_log_plan_id" ON "departure_log" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_memo_user_id_created_at" ON "memo" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memo_created_at" ON "memo" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_plan_user_id_created_at" ON "plan" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_plan_item_plan_id_sequence" ON "plan_item" USING btree ("plan_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_routine_user_id" ON "routine" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_slot_evaluation_plan_id_evaluation_order" ON "slot_evaluation" USING btree ("plan_id","evaluation_order");