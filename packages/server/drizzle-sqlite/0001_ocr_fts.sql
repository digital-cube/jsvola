-- The OCR text search on SQLite: an FTS5 index over vola_file_metadata.ocr_text, the
-- counterpart of PostgreSQL's ocr_tsv + GIN index. Hand-written: drizzle cannot describe a
-- virtual table or a trigger, so neither is in the schema or its snapshot.
--
-- vola_file_ocr_fts_doc gives every indexed file a stable INTEGER PRIMARY KEY, the rowid of
-- its entry in the index. Not vola_file_metadata's own rowid: that table's key is a TEXT id,
-- and VACUUM (and VACUUM INTO, the documented backup) may renumber the implicit rowid of
-- such a table, which would silently point an external-content index at the wrong rows.
--
-- vola_file_ocr_fts is contentless (content='', contentless_delete=1): the text is stored
-- once, in vola_file_metadata; the index holds the tokens only. Tokenizer unicode61 with
-- remove_diacritics 0: case folded, diacritics kept (č and c stay distinct), as PostgreSQL's
-- 'simple' configuration does. Like ocr_tsv, only the first 500000 characters are indexed
-- (OCR_TSV_MAX_CHARS in src/db/schema-postgres.ts).
--
-- The triggers keep the index in step with every write of vola_file_metadata: the OCR pass's
-- upsert, the encrypted pass that sets ocr_text to NULL, and the cascade of a purged file.
CREATE TABLE `vola_file_ocr_fts_doc` (
	`id` integer PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `vola_file_ocr_fts` USING fts5(
	`ocr_text`,
	content = '',
	contentless_delete = 1,
	tokenize = 'unicode61 remove_diacritics 0'
);
--> statement-breakpoint
CREATE TRIGGER `vola_file_metadata_ocr_fts_ai` AFTER INSERT ON `vola_file_metadata`
WHEN coalesce(new.`ocr_text`, '') <> ''
BEGIN
	INSERT INTO `vola_file_ocr_fts_doc` (`file_id`) VALUES (new.`file_id`);
	INSERT INTO `vola_file_ocr_fts` (`rowid`, `ocr_text`)
		SELECT `id`, substr(new.`ocr_text`, 1, 500000) FROM `vola_file_ocr_fts_doc`
		WHERE `file_id` = new.`file_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `vola_file_metadata_ocr_fts_au` AFTER UPDATE OF `file_id`, `ocr_text` ON `vola_file_metadata`
BEGIN
	DELETE FROM `vola_file_ocr_fts` WHERE `rowid` IN (
		SELECT `id` FROM `vola_file_ocr_fts_doc` WHERE `file_id` = old.`file_id`
	);
	DELETE FROM `vola_file_ocr_fts_doc` WHERE `file_id` = old.`file_id`;
	INSERT INTO `vola_file_ocr_fts_doc` (`file_id`)
		SELECT new.`file_id` WHERE coalesce(new.`ocr_text`, '') <> '';
	INSERT INTO `vola_file_ocr_fts` (`rowid`, `ocr_text`)
		SELECT `id`, substr(new.`ocr_text`, 1, 500000) FROM `vola_file_ocr_fts_doc`
		WHERE `file_id` = new.`file_id` AND coalesce(new.`ocr_text`, '') <> '';
END;
--> statement-breakpoint
CREATE TRIGGER `vola_file_metadata_ocr_fts_ad` AFTER DELETE ON `vola_file_metadata`
BEGIN
	DELETE FROM `vola_file_ocr_fts` WHERE `rowid` IN (
		SELECT `id` FROM `vola_file_ocr_fts_doc` WHERE `file_id` = old.`file_id`
	);
	DELETE FROM `vola_file_ocr_fts_doc` WHERE `file_id` = old.`file_id`;
END;
--> statement-breakpoint
-- The text already there when this migration runs (a database copied in, rows written by
-- hand): indexed now, as the triggers will index everything from here on.
INSERT INTO `vola_file_ocr_fts_doc` (`file_id`)
	SELECT `file_id` FROM `vola_file_metadata` WHERE coalesce(`ocr_text`, '') <> '';
--> statement-breakpoint
INSERT INTO `vola_file_ocr_fts` (`rowid`, `ocr_text`)
	SELECT d.`id`, substr(m.`ocr_text`, 1, 500000)
	FROM `vola_file_ocr_fts_doc` d JOIN `vola_file_metadata` m ON m.`file_id` = d.`file_id`;
