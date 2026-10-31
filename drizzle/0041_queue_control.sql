ALTER TYPE "public"."audit_action" ADD VALUE 'queue_changed';--> statement-breakpoint
CREATE TABLE "backlog" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"repo" text,
	"position" integer NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_controls" (
	"job_id" text PRIMARY KEY NOT NULL,
	"front_at" timestamp with time zone,
	"held_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_state" (
	"id" text PRIMARY KEY NOT NULL,
	"paused_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
