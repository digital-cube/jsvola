CREATE TABLE "vola_upload" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid,
	"instance_type" varchar(100) NOT NULL,
	"instance_id" uuid NOT NULL,
	"folder_path" text,
	"folder_id" uuid,
	"parent_id" uuid,
	"slug" varchar(100),
	"filename" varchar(255) NOT NULL,
	"declared_mime" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"length" bigint NOT NULL,
	"offset" bigint DEFAULT 0 NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_file_id" uuid,
	"encryption" varchar(16),
	"enc_state" jsonb,
	CONSTRAINT "vola_upload_instance_type_check" CHECK ("vola_upload"."instance_type" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "vola_upload_length_check" CHECK ("vola_upload"."length" >= 0),
	CONSTRAINT "vola_upload_offset_check" CHECK ("vola_upload"."offset" >= 0 and "vola_upload"."offset" <= "vola_upload"."length")
);
--> statement-breakpoint
ALTER TABLE "vola_upload" ADD CONSTRAINT "vola_upload_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_upload" ADD CONSTRAINT "vola_upload_api_key_id_vola_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."vola_apikey"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_upload" ADD CONSTRAINT "vola_upload_folder_id_vola_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."vola_folder"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_upload" ADD CONSTRAINT "vola_upload_parent_id_vola_file_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."vola_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_upload" ADD CONSTRAINT "vola_upload_completed_file_id_vola_file_id_fk" FOREIGN KEY ("completed_file_id") REFERENCES "public"."vola_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vola_upload_tenant_idx" ON "vola_upload" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "vola_upload_expires_idx" ON "vola_upload" USING btree ("expires_at");