CREATE TABLE "vola_file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_type" varchar(100) NOT NULL,
	"instance_id" uuid NOT NULL,
	"slug" varchar(100),
	"hash" varchar(64) NOT NULL,
	"size" bigint NOT NULL,
	"filename" varchar(255) NOT NULL,
	"extension" varchar(50),
	"mime_type" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"folder_id" uuid,
	"parent_id" uuid,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_global_public" boolean DEFAULT false NOT NULL,
	"encryption" varchar(16) DEFAULT 'none' NOT NULL,
	"enc_format" smallint,
	"keyring_id" uuid,
	"fk_ct" "bytea",
	"meta_ct" "bytea",
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" varchar(255),
	"last_accessed_at" timestamp with time zone,
	"last_accessed_by" varchar(255),
	CONSTRAINT "vola_file_instance_type_check" CHECK ("vola_file"."instance_type" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "vola_file_hash_check" CHECK ("vola_file"."hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "vola_file_size_check" CHECK ("vola_file"."size" >= 0),
	CONSTRAINT "vola_file_encryption_check" CHECK ("vola_file"."encryption" in ('none', 'tenant', 'keyring', 'caller'))
);
--> statement-breakpoint
ALTER TABLE "vola_file" ADD CONSTRAINT "vola_file_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vola_file_instance_idx" ON "vola_file" USING btree ("tenant_id","instance_type","instance_id");--> statement-breakpoint
CREATE INDEX "vola_file_hash_idx" ON "vola_file" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "vola_file_slug_live_uq" ON "vola_file" USING btree ("tenant_id","instance_type","instance_id","slug") WHERE "vola_file"."deleted_at" is null and "vola_file"."slug" is not null;