CREATE TABLE "job_worker_reports" (
	"client_instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"alive_since" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_worker_reports_client_instance_id_kind_pk" PRIMARY KEY("client_instance_id","kind")
);
