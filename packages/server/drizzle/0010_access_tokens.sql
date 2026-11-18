CREATE TABLE "vola_access_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"principal" varchar(255) NOT NULL,
	"file_ids" jsonb,
	"instance_type" varchar(100),
	"instance_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "vola_access_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "vola_access_token_target_check" CHECK (("vola_access_token"."file_ids" is null) <> ("vola_access_token"."instance_type" is null) and ("vola_access_token"."instance_type" is null) = ("vola_access_token"."instance_id" is null))
);
--> statement-breakpoint
ALTER TABLE "vola_access_token" ADD CONSTRAINT "vola_access_token_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_access_token" ADD CONSTRAINT "vola_access_token_api_key_id_vola_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."vola_apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vola_access_token_tenant_expires_idx" ON "vola_access_token" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "vola_access_token_apikey_idx" ON "vola_access_token" USING btree ("api_key_id");