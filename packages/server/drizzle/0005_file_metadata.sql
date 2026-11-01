CREATE TABLE "vola_file_metadata" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ocr_text" text,
	"ocr_lang" varchar(64),
	"ocr_pages" integer,
	"ocr_at" timestamp with time zone,
	"ocr_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', left(coalesce(ocr_text, ''), 500000))) STORED,
	CONSTRAINT "vola_file_metadata_ocr_pages_check" CHECK ("vola_file_metadata"."ocr_pages" is null or "vola_file_metadata"."ocr_pages" >= 0)
);
--> statement-breakpoint
ALTER TABLE "vola_file_metadata" ADD CONSTRAINT "vola_file_metadata_file_id_vola_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vola_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vola_file_metadata" ADD CONSTRAINT "vola_file_metadata_tenant_id_vola_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."vola_tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vola_file_metadata_tenant_idx" ON "vola_file_metadata" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "vola_file_metadata_ocr_tsv_idx" ON "vola_file_metadata" USING gin ("ocr_tsv");