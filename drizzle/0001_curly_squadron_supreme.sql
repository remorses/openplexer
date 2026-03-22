PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`notion_database_id` text NOT NULL,
	`notion_page_id` text NOT NULL,
	`tracked_repos` text DEFAULT '[]' NOT NULL,
	`connected_at` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_boards`("id", "account_id", "notion_database_id", "notion_page_id", "tracked_repos", "connected_at", "created_at") SELECT "id", "account_id", "notion_database_id", "notion_page_id", "tracked_repos", "connected_at", "created_at" FROM `boards`;--> statement-breakpoint
DROP TABLE `boards`;--> statement-breakpoint
ALTER TABLE `__new_boards` RENAME TO `boards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `boards_notion_database_id_unique` ON `boards` (`notion_database_id`);