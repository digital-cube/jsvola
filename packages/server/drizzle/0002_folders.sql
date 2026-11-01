CREATE TABLE "vola_folder" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_type" varchar(100) NOT NULL,
	"instance_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" varchar(255) NOT NULL,
	"path" text NOT NULL,
	"default_keyring_id" uuid,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" varchar(255),
	CONSTRAINT "vola_folder_instance_type_check" CHECK ("vola_folder"."instance_type" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "vola_folder_path_check" CHECK ("vola_folder"."path" <> '' and "vola_folder"."path" !~ '(^/|/$|//)')
);
--> statement-breakpoint
ALTER TABLE "vola_folder" ADD CONSTRAINT "vola_folder_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_folder" ADD CONSTRAINT "vola_folder_parent_id_vola_folder_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."vola_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vola_folder_path_live_uq" ON "vola_folder" USING btree ("tenant_id","instance_type","instance_id","path") WHERE "vola_folder"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "vola_folder_parent_idx" ON "vola_folder" USING btree ("tenant_id","instance_type","instance_id","parent_id");--> statement-breakpoint
ALTER TABLE "vola_file" ADD CONSTRAINT "vola_file_folder_id_vola_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."vola_folder"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_file" ADD CONSTRAINT "vola_file_parent_id_vola_file_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."vola_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vola_file_folder_idx" ON "vola_file" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "vola_file_parent_idx" ON "vola_file" USING btree ("parent_id");