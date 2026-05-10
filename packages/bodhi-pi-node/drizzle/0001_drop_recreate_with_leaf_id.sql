DROP TABLE IF EXISTS `session_entries`;
--> statement-breakpoint
DROP TABLE IF EXISTS `sessions`;
--> statement-breakpoint
CREATE TABLE `session_entries` (
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`entry_id` text NOT NULL,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`session_id`, `ordinal`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`cwd` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`leaf_id` text
);
--> statement-breakpoint
CREATE INDEX `sessions_cwd_updated_id_idx` ON `sessions` (`cwd`,`updated_at`,`id`);
