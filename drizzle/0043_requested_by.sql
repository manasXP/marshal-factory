CREATE TABLE "job_filings" (
	"key" text PRIMARY KEY NOT NULL,
	"filed_by" text NOT NULL,
	"filed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "requested_by" text;