CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "model" text;