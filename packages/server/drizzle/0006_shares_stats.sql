CREATE TABLE "vola_share_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid,
	"folder_id" uuid,
	"token_hash" varchar(64) NOT NULL,
	"scope" varchar(20) DEFAULT 'PUBLIC_LINK' NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"max_downloads" integer,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"fk_share_ct" "bytea",
	CONSTRAINT "vola_share_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "vola_share_link_target_check" CHECK (("vola_share_link"."file_id" is null) <> ("vola_share_link"."folder_id" is null)),
	CONSTRAINT "vola_share_link_scope_check" CHECK ("vola_share_link"."scope" in ('PUBLIC_LINK', 'TENANT', 'INSTANCE_VIEWERS', 'EMAIL')),
	CONSTRAINT "vola_share_link_max_downloads_check" CHECK ("vola_share_link"."max_downloads" is null or "vola_share_link"."max_downloads" > 0),
	CONSTRAINT "vola_share_link_download_count_check" CHECK ("vola_share_link"."download_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vola_tenant_stats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" varchar(10) NOT NULL,
	"instance_type" varchar(100),
	"instance_id" uuid,
	"total_files" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"by_kind" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"oldest_at" timestamp with time zone,
	"newest_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vola_tenant_stats_scope_check" CHECK ("vola_tenant_stats"."scope" in ('tenant', 'instance')),
	CONSTRAINT "vola_tenant_stats_instance_check" CHECK (("vola_tenant_stats"."scope" = 'tenant' and "vola_tenant_stats"."instance_type" is null and "vola_tenant_stats"."instance_id" is null) or ("vola_tenant_stats"."scope" = 'instance' and "vola_tenant_stats"."instance_type" is not null and "vola_tenant_stats"."instance_id" is not null)),
	CONSTRAINT "vola_tenant_stats_totals_check" CHECK ("vola_tenant_stats"."total_files" >= 0 and "vola_tenant_stats"."total_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "vola_share_link" ADD CONSTRAINT "vola_share_link_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_share_link" ADD CONSTRAINT "vola_share_link_file_id_vola_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vola_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_share_link" ADD CONSTRAINT "vola_share_link_folder_id_vola_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."vola_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_tenant_stats" ADD CONSTRAINT "vola_tenant_stats_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vola_share_link_tenant_idx" ON "vola_share_link" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "vola_share_link_file_idx" ON "vola_share_link" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "vola_share_link_folder_idx" ON "vola_share_link" USING btree ("folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vola_tenant_stats_tenant_uq" ON "vola_tenant_stats" USING btree ("tenant_id") WHERE "vola_tenant_stats"."scope" = 'tenant';--> statement-breakpoint
CREATE UNIQUE INDEX "vola_tenant_stats_instance_uq" ON "vola_tenant_stats" USING btree ("tenant_id","instance_type","instance_id") WHERE "vola_tenant_stats"."scope" = 'instance';--> statement-breakpoint
CREATE INDEX "vola_tenant_stats_computed_idx" ON "vola_tenant_stats" USING btree ("computed_at");