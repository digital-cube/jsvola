CREATE TABLE `vola_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`api_key_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`principal` text NOT NULL,
	`file_ids` text,
	`instance_type` text,
	`instance_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `vola_apikey`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_access_token_target_check" CHECK(("vola_access_token"."file_ids" is null) <> ("vola_access_token"."instance_type" is null) and ("vola_access_token"."instance_type" is null) = ("vola_access_token"."instance_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_access_token_token_hash_unique` ON `vola_access_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `vola_access_token_tenant_expires_idx` ON `vola_access_token` (`tenant_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `vola_access_token_apikey_idx` ON `vola_access_token` (`api_key_id`);