ALTER TABLE "vola_file" DROP CONSTRAINT "vola_file_encryption_check";--> statement-breakpoint
ALTER TABLE "vola_file_metadata" ADD COLUMN "ocr_ct" "bytea";--> statement-breakpoint
ALTER TABLE "vola_file" ADD CONSTRAINT "vola_file_encryption_check" CHECK ("vola_file"."encryption" in ('none', 'tenant', 'keyring', 'caller', 'client'));