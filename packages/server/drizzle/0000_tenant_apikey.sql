CREATE TABLE "vola_apikey" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"name" varchar(200) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"last4" varchar(4) NOT NULL,
	"scopes" text[] NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" varchar(255),
	CONSTRAINT "vola_apikey_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "vola_apikey_prefix_check" CHECK ("vola_apikey"."prefix" in ('vola_live', 'vola_test', 'vola_admin')),
	CONSTRAINT "vola_apikey_admin_check" CHECK (("vola_apikey"."tenant_id" is null) = "vola_apikey"."is_admin")
);
--> statement-breakpoint
CREATE TABLE "vola_tenant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vola_tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "vola_apikey" ADD CONSTRAINT "vola_apikey_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vola_apikey_tenant_idx" ON "vola_apikey" USING btree ("tenant_id");