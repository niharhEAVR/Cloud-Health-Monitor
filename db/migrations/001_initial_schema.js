export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true });

  pgm.createTable("services", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "varchar(100)", notNull: true },
    normalized_url: { type: "varchar(2048)", notNull: true, unique: true },
    interval_seconds: { type: "integer", notNull: true, default: 60 },
    accepted_status_min: { type: "smallint", notNull: true, default: 200 },
    accepted_status_max: { type: "smallint", notNull: true, default: 299 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    next_check_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    lease_token: { type: "uuid" },
    lease_owner: { type: "varchar(128)" },
    lease_expires_at: { type: "timestamptz" },
    latest_scheduled_at: { type: "timestamptz" },
    latest_completed_at: { type: "timestamptz" },
    latest_outcome: { type: "varchar(4)" },
    latest_http_status: { type: "smallint" },
    latest_response_time_ms: { type: "integer" },
    latest_duration_ms: { type: "integer" },
    latest_error_code: { type: "varchar(32)" },
  });
  pgm.addConstraint("services", "services_name_not_blank", "CHECK (char_length(btrim(name)) > 0)");
  pgm.addConstraint(
    "services",
    "services_interval_seconds_range",
    "CHECK (interval_seconds BETWEEN 30 AND 86400)",
  );
  pgm.addConstraint(
    "services",
    "services_accepted_status_range",
    "CHECK (accepted_status_min BETWEEN 100 AND 599 AND accepted_status_max BETWEEN 100 AND 599 AND accepted_status_min <= accepted_status_max)",
  );
  pgm.addConstraint(
    "services",
    "services_lease_completeness",
    "CHECK ((lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))",
  );
  pgm.addConstraint(
    "services",
    "services_latest_snapshot_consistency",
    "CHECK ((latest_completed_at IS NULL AND latest_scheduled_at IS NULL AND latest_outcome IS NULL AND latest_http_status IS NULL AND latest_response_time_ms IS NULL AND latest_duration_ms IS NULL AND latest_error_code IS NULL) OR (latest_completed_at IS NOT NULL AND latest_scheduled_at IS NOT NULL AND latest_scheduled_at <= latest_completed_at AND latest_duration_ms >= 0 AND ((latest_outcome = 'up' AND latest_http_status BETWEEN accepted_status_min AND accepted_status_max AND latest_response_time_ms BETWEEN 0 AND latest_duration_ms AND latest_error_code IS NULL) OR (latest_outcome = 'down' AND ((latest_http_status BETWEEN 100 AND 599 AND latest_response_time_ms BETWEEN 0 AND latest_duration_ms AND latest_error_code = 'HTTP_STATUS') OR (latest_http_status IS NULL AND latest_response_time_ms IS NULL AND latest_error_code IN ('TIMEOUT', 'DNS_ERROR', 'TLS_ERROR', 'CONNECTION_ERROR', 'TARGET_BLOCKED', 'PROTOCOL_ERROR')))))))",
  );

  pgm.createTable("health_checks", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    service_id: { type: "uuid", notNull: true, references: '"services"', onDelete: "cascade" },
    lease_token: { type: "uuid", notNull: true, unique: true },
    scheduled_at: { type: "timestamptz", notNull: true },
    started_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz", notNull: true },
    outcome: { type: "varchar(4)", notNull: true },
    http_status: { type: "smallint" },
    response_time_ms: { type: "integer" },
    total_duration_ms: { type: "integer", notNull: true },
    error_code: { type: "varchar(32)" },
    accepted_status_min: { type: "smallint", notNull: true },
    accepted_status_max: { type: "smallint", notNull: true },
  });
  pgm.addConstraint("health_checks", "health_checks_timestamp_order", "CHECK (scheduled_at <= completed_at AND started_at <= completed_at)");
  pgm.addConstraint("health_checks", "health_checks_duration_nonnegative", "CHECK (total_duration_ms >= 0 AND (response_time_ms IS NULL OR response_time_ms BETWEEN 0 AND total_duration_ms))");
  pgm.addConstraint("health_checks", "health_checks_status_policy", "CHECK (accepted_status_min BETWEEN 100 AND 599 AND accepted_status_max BETWEEN 100 AND 599 AND accepted_status_min <= accepted_status_max)");
  pgm.addConstraint(
    "health_checks",
    "health_checks_result_consistency",
    "CHECK ((outcome = 'up' AND http_status BETWEEN accepted_status_min AND accepted_status_max AND response_time_ms IS NOT NULL AND error_code IS NULL) OR (outcome = 'down' AND ((http_status IS NOT NULL AND http_status BETWEEN 100 AND 599 AND error_code = 'HTTP_STATUS') OR (http_status IS NULL AND error_code IN ('TIMEOUT', 'DNS_ERROR', 'TLS_ERROR', 'CONNECTION_ERROR', 'TARGET_BLOCKED', 'PROTOCOL_ERROR')))))",
  );

  pgm.createTable("health_check_hourly", {
    service_id: { type: "uuid", notNull: true, references: '"services"', onDelete: "cascade" },
    hour_start: { type: "timestamptz", notNull: true },
    completed_checks: { type: "integer", notNull: true, default: 0 },
    accepted_checks: { type: "integer", notNull: true, default: 0 },
    response_time_count: { type: "integer", notNull: true, default: 0 },
    response_time_sum_ms: { type: "bigint", notNull: true, default: 0 },
    response_time_min_ms: { type: "integer" },
    response_time_max_ms: { type: "integer" },
  }, {
    constraints: { primaryKey: ["service_id", "hour_start"] },
  });
  pgm.addConstraint("health_check_hourly", "health_check_hourly_utc_hour", "CHECK (hour_start = date_trunc('hour', hour_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')");
  pgm.addConstraint("health_check_hourly", "health_check_hourly_counts", "CHECK (completed_checks >= 0 AND accepted_checks BETWEEN 0 AND completed_checks AND response_time_count BETWEEN 0 AND completed_checks AND response_time_sum_ms >= 0)");
  pgm.addConstraint("health_check_hourly", "health_check_hourly_latency_consistency", "CHECK ((response_time_count = 0 AND response_time_min_ms IS NULL AND response_time_max_ms IS NULL AND response_time_sum_ms = 0) OR (response_time_count > 0 AND response_time_min_ms >= 0 AND response_time_max_ms >= response_time_min_ms AND response_time_sum_ms >= response_time_count::bigint * response_time_min_ms AND response_time_sum_ms <= response_time_count::bigint * response_time_max_ms))");

  pgm.createTable("worker_heartbeats", {
    worker_id: { type: "uuid", primaryKey: true },
    last_seen_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    scheduler_ran_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("worker_heartbeats", "worker_heartbeats_timestamp_order", "CHECK (scheduler_ran_at <= last_seen_at)");

  pgm.createTable("service_create_requests", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    idempotency_key: { type: "varchar(255)", notNull: true, unique: true },
    request_hash: { type: "char(64)", notNull: true },
    service_id: { type: "uuid", notNull: true, references: '"services"', onDelete: "cascade" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    expires_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("service_create_requests", "service_create_requests_hash", "CHECK (request_hash ~ '^[0-9a-f]{64}$')");
  pgm.addConstraint("service_create_requests", "service_create_requests_expiry", "CHECK (expires_at > created_at)");

  pgm.createIndex("services", "next_check_at", { name: "services_due_claim_idx", where: "lease_token IS NULL" });
  pgm.createIndex("services", "lease_expires_at", { name: "services_expired_lease_idx", where: "lease_token IS NOT NULL" });
  pgm.createIndex("health_checks", ["service_id", { name: "completed_at", sort: "DESC" }, { name: "id", sort: "DESC" }], { name: "health_checks_service_history_idx" });
  pgm.createIndex("health_checks", "completed_at", { name: "health_checks_retention_idx" });
  pgm.createIndex("health_check_hourly", ["service_id", { name: "hour_start", sort: "DESC" }], { name: "health_check_hourly_service_idx" });
  pgm.createIndex("worker_heartbeats", "last_seen_at", { name: "worker_heartbeats_freshness_idx" });
  pgm.createIndex("service_create_requests", "expires_at", { name: "service_create_requests_expiry_idx" });

  pgm.createFunction(
    "set_updated_at",
    [],
    { returns: "trigger", language: "plpgsql" },
    "BEGIN NEW.updated_at = now(); RETURN NEW; END;",
  );
  pgm.createTrigger("services", "services_set_updated_at", {
    when: "BEFORE",
    operation: "UPDATE",
    level: "ROW",
    function: "set_updated_at",
  });
  pgm.createTrigger("worker_heartbeats", "worker_heartbeats_set_updated_at", {
    when: "BEFORE",
    operation: "UPDATE",
    level: "ROW",
    function: "set_updated_at",
  });
};

export const down = (pgm) => {
  pgm.dropTable("service_create_requests");
  pgm.dropTable("worker_heartbeats");
  pgm.dropTable("health_check_hourly");
  pgm.dropTable("health_checks");
  pgm.dropTable("services");
  pgm.dropFunction("set_updated_at");
  pgm.dropExtension("pgcrypto", { ifExists: true });
};
