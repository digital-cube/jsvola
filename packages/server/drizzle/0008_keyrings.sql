CREATE TABLE "vola_keyring" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal" varchar(255) NOT NULL,
	"kdf" jsonb NOT NULL,
	"mk_pin_ct" "bytea" NOT NULL,
	"mk_recovery_ct" "bytea" NOT NULL,
	"recovery_salt" "bytea" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"pin_set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vola_keyring_attempts_check" CHECK ("vola_keyring"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "vola_keyring" ADD CONSTRAINT "vola_keyring_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vola_keyring_principal_live_uq" ON "vola_keyring" USING btree ("tenant_id","principal") WHERE "vola_keyring"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "vola_file_keyring_idx" ON "vola_file" USING btree ("keyring_id");