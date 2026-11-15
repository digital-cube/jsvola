CREATE TABLE `vola_apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`last4` text NOT NULL,
	`scopes` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_by` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_apikey_prefix_check" CHECK("vola_apikey"."prefix" in ('vola_live', 'vola_test', 'vola_admin')),
	CONSTRAINT "vola_apikey_admin_check" CHECK(("vola_apikey"."tenant_id" is null) = "vola_apikey"."is_admin")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_apikey_key_hash_unique` ON `vola_apikey` (`key_hash`);--> statement-breakpoint
CREATE INDEX `vola_apikey_tenant_idx` ON `vola_apikey` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `vola_file_metadata` (
	`file_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`ocr_text` text,
	`ocr_lang` text,
	`ocr_pages` integer,
	`ocr_at` integer,
	`ocr_ct` blob,
	FOREIGN KEY (`file_id`) REFERENCES `vola_file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_file_metadata_ocr_pages_check" CHECK("vola_file_metadata"."ocr_pages" is null or "vola_file_metadata"."ocr_pages" >= 0)
);
--> statement-breakpoint
CREATE INDEX `vola_file_metadata_tenant_idx` ON `vola_file_metadata` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `vola_file` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`instance_type` text NOT NULL,
	`instance_id` text NOT NULL,
	`slug` text,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`filename` text NOT NULL,
	`extension` text,
	`mime_type` text NOT NULL,
	`kind` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`folder_id` text,
	`parent_id` text,
	`is_public` integer DEFAULT false NOT NULL,
	`is_global_public` integer DEFAULT false NOT NULL,
	`encryption` text DEFAULT 'none' NOT NULL,
	`enc_format` integer,
	`keyring_id` text,
	`fk_ct` blob,
	`meta_ct` blob,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	`last_accessed_at` integer,
	`last_accessed_by` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `vola_folder`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `vola_file`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "vola_file_instance_type_check" CHECK("vola_file"."instance_type" glob '[a-z]*' and "vola_file"."instance_type" not glob '*[^a-z0-9_]*'),
	CONSTRAINT "vola_file_hash_check" CHECK(length("vola_file"."hash") = 64 and "vola_file"."hash" not glob '*[^a-f0-9]*'),
	CONSTRAINT "vola_file_size_check" CHECK("vola_file"."size" >= 0),
	CONSTRAINT "vola_file_encryption_check" CHECK("vola_file"."encryption" in ('none', 'tenant', 'keyring', 'caller', 'client'))
);
--> statement-breakpoint
CREATE INDEX `vola_file_instance_idx` ON `vola_file` (`tenant_id`,`instance_type`,`instance_id`);--> statement-breakpoint
CREATE INDEX `vola_file_hash_idx` ON `vola_file` (`hash`);--> statement-breakpoint
CREATE INDEX `vola_file_folder_idx` ON `vola_file` (`folder_id`);--> statement-breakpoint
CREATE INDEX `vola_file_parent_idx` ON `vola_file` (`parent_id`);--> statement-breakpoint
CREATE INDEX `vola_file_keyring_idx` ON `vola_file` (`keyring_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vola_file_slug_live_uq` ON `vola_file` (`tenant_id`,`instance_type`,`instance_id`,`slug`) WHERE "vola_file"."deleted_at" is null and "vola_file"."slug" is not null;--> statement-breakpoint
CREATE TABLE `vola_folder` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`instance_type` text NOT NULL,
	`instance_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_keyring_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `vola_folder`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_folder_instance_type_check" CHECK("vola_folder"."instance_type" glob '[a-z]*' and "vola_folder"."instance_type" not glob '*[^a-z0-9_]*'),
	CONSTRAINT "vola_folder_path_check" CHECK("vola_folder"."path" <> '' and "vola_folder"."path" not glob '/*' and "vola_folder"."path" not glob '*/' and instr("vola_folder"."path", '//') = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_folder_path_live_uq` ON `vola_folder` (`tenant_id`,`instance_type`,`instance_id`,`path`) WHERE "vola_folder"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `vola_folder_parent_idx` ON `vola_folder` (`tenant_id`,`instance_type`,`instance_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `vola_keyring` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`principal` text NOT NULL,
	`kdf` text NOT NULL,
	`mk_pin_ct` blob NOT NULL,
	`mk_recovery_ct` blob NOT NULL,
	`recovery_salt` blob NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`pin_set_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_keyring_attempts_check" CHECK("vola_keyring"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_keyring_principal_live_uq` ON `vola_keyring` (`tenant_id`,`principal`) WHERE "vola_keyring"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `vola_processing_job` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`file_id` text NOT NULL,
	`kind` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `vola_file`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_processing_job_kind_check" CHECK("vola_processing_job"."kind" in ('THUMBNAIL', 'OCR')),
	CONSTRAINT "vola_processing_job_status_check" CHECK("vola_processing_job"."status" in ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED')),
	CONSTRAINT "vola_processing_job_attempts_check" CHECK("vola_processing_job"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_processing_job_identity_uq` ON `vola_processing_job` (`file_id`,`kind`,`params`);--> statement-breakpoint
CREATE INDEX `vola_processing_job_tenant_status_idx` ON `vola_processing_job` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `vola_share_link` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`file_id` text,
	`folder_id` text,
	`token_hash` text NOT NULL,
	`scope` text DEFAULT 'PUBLIC_LINK' NOT NULL,
	`password_hash` text,
	`expires_at` integer,
	`max_downloads` integer,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`revoked_at` integer,
	`fk_share_ct` blob,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `vola_file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `vola_folder`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_share_link_target_check" CHECK(("vola_share_link"."file_id" is null) <> ("vola_share_link"."folder_id" is null)),
	CONSTRAINT "vola_share_link_scope_check" CHECK("vola_share_link"."scope" in ('PUBLIC_LINK', 'TENANT', 'INSTANCE_VIEWERS', 'EMAIL')),
	CONSTRAINT "vola_share_link_max_downloads_check" CHECK("vola_share_link"."max_downloads" is null or "vola_share_link"."max_downloads" > 0),
	CONSTRAINT "vola_share_link_download_count_check" CHECK("vola_share_link"."download_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_share_link_token_hash_unique` ON `vola_share_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `vola_share_link_tenant_idx` ON `vola_share_link` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `vola_share_link_file_idx` ON `vola_share_link` (`file_id`);--> statement-breakpoint
CREATE INDEX `vola_share_link_folder_idx` ON `vola_share_link` (`folder_id`);--> statement-breakpoint
CREATE TABLE `vola_tenant_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`scope` text NOT NULL,
	`instance_type` text,
	`instance_id` text,
	`total_files` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`by_kind` text DEFAULT '{}' NOT NULL,
	`oldest_at` integer,
	`newest_at` integer,
	`computed_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vola_tenant_stats_scope_check" CHECK("vola_tenant_stats"."scope" in ('tenant', 'instance')),
	CONSTRAINT "vola_tenant_stats_instance_check" CHECK(("vola_tenant_stats"."scope" = 'tenant' and "vola_tenant_stats"."instance_type" is null and "vola_tenant_stats"."instance_id" is null) or ("vola_tenant_stats"."scope" = 'instance' and "vola_tenant_stats"."instance_type" is not null and "vola_tenant_stats"."instance_id" is not null)),
	CONSTRAINT "vola_tenant_stats_totals_check" CHECK("vola_tenant_stats"."total_files" >= 0 and "vola_tenant_stats"."total_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_tenant_stats_tenant_uq` ON `vola_tenant_stats` (`tenant_id`) WHERE "vola_tenant_stats"."scope" = 'tenant';--> statement-breakpoint
CREATE UNIQUE INDEX `vola_tenant_stats_instance_uq` ON `vola_tenant_stats` (`tenant_id`,`instance_type`,`instance_id`) WHERE "vola_tenant_stats"."scope" = 'instance';--> statement-breakpoint
CREATE INDEX `vola_tenant_stats_computed_idx` ON `vola_tenant_stats` (`computed_at`);--> statement-breakpoint
CREATE TABLE `vola_tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`default_encryption` text DEFAULT 'none' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT "vola_tenant_default_encryption_check" CHECK("vola_tenant"."default_encryption" in ('none', 'tenant', 'keyring', 'caller'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vola_tenant_slug_unique` ON `vola_tenant` (`slug`);--> statement-breakpoint
CREATE TABLE `vola_upload` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`api_key_id` text,
	`instance_type` text NOT NULL,
	`instance_id` text NOT NULL,
	`folder_path` text,
	`folder_id` text,
	`parent_id` text,
	`slug` text,
	`filename` text NOT NULL,
	`declared_mime` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`length` integer NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_file_id` text,
	`encryption` text,
	`enc_state` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `vola_tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `vola_apikey`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`folder_id`) REFERENCES `vola_folder`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `vola_file`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`completed_file_id`) REFERENCES `vola_file`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "vola_upload_instance_type_check" CHECK("vola_upload"."instance_type" glob '[a-z]*' and "vola_upload"."instance_type" not glob '*[^a-z0-9_]*'),
	CONSTRAINT "vola_upload_length_check" CHECK("vola_upload"."length" >= 0),
	CONSTRAINT "vola_upload_offset_check" CHECK("vola_upload"."offset" >= 0 and "vola_upload"."offset" <= "vola_upload"."length")
);
--> statement-breakpoint
CREATE INDEX `vola_upload_tenant_idx` ON `vola_upload` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `vola_upload_expires_idx` ON `vola_upload` (`expires_at`);