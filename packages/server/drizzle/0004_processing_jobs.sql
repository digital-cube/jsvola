CREATE TABLE "vola_processing_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "vola_processing_job_kind_check" CHECK ("vola_processing_job"."kind" in ('THUMBNAIL', 'OCR')),
	CONSTRAINT "vola_processing_job_status_check" CHECK ("vola_processing_job"."status" in ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED')),
	CONSTRAINT "vola_processing_job_attempts_check" CHECK ("vola_processing_job"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "vola_processing_job" ADD CONSTRAINT "vola_processing_job_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_processing_job" ADD CONSTRAINT "vola_processing_job_file_id_vola_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vola_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vola_processing_job_identity_uq" ON "vola_processing_job" USING btree ("file_id","kind","params");--> statement-breakpoint
CREATE INDEX "vola_processing_job_tenant_status_idx" ON "vola_processing_job" USING btree ("tenant_id","status");