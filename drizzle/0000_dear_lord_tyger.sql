CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`notion_user_id` text NOT NULL,
	`notion_user_name` text,
	`workspace_id` text NOT NULL,
	`workspace_name` text,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_notion_user_id_unique` ON `accounts` (`notion_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_refresh_token_unique` ON `accounts` (`refresh_token`);--> statement-breakpoint
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`notion_database_id` text NOT NULL,
	`notion_page_id` text NOT NULL,
	`tracked_repos` text DEFAULT '[]' NOT NULL,
	`connected_at` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_notion_database_id_unique` ON `boards` (`notion_database_id`);