-- Proposed PostgreSQL 17+ migration. Execute once with the schema-owner role.
-- Runtime credentials must not own this schema or have DDL privileges.
CREATE SCHEMA hub_metadata;

CREATE TABLE hub_metadata.schema_migrations (
    version bigint PRIMARY KEY CHECK (version > 0),
    checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE hub_metadata.deployments (
    namespace text COLLATE "C" PRIMARY KEY CHECK (octet_length(namespace) BETWEEN 1 AND 128),
    backend_epoch bigint NOT NULL CHECK (backend_epoch > 0),
    state text NOT NULL CHECK (state IN ('importing', 'active', 'frozen', 'retired')),
    artifact_store_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- body is the sole authoritative payload. The session columns are query projections.
CREATE TABLE hub_metadata.records (
    namespace text COLLATE "C" NOT NULL REFERENCES hub_metadata.deployments(namespace),
    key text COLLATE "C" NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 1024),
    body bytea NOT NULL,
    etag uuid NOT NULL DEFAULT gen_random_uuid(),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    size_bytes bigint GENERATED ALWAYS AS (octet_length(body)::bigint) STORED,
    http_metadata jsonb,
    custom_metadata jsonb,
    session_id text COLLATE "C",
    project_id text COLLATE "C",
    notebook_id text COLLATE "C",
    user_id text COLLATE "C",
    session_status text COLLATE "C",
    session_mode text COLLATE "C",
    session_started_at timestamptz,
    session_last_heartbeat timestamptz,
    session_expires_at timestamptz,
    session_authorization_expires_at timestamptz,
    session_sandbox_id text COLLATE "C",
    session_reclaimed_at timestamptz,
    PRIMARY KEY (namespace, key),
    CHECK (http_metadata IS NULL OR jsonb_typeof(http_metadata) = 'object'),
    CHECK (custom_metadata IS NULL OR jsonb_typeof(custom_metadata) = 'object')
);

-- Match core's UTC input shape and JavaScript Date millisecond precision.
CREATE FUNCTION hub_metadata.session_time(value text) RETURNS timestamptz
LANGUAGE plpgsql STRICT SET search_path = pg_catalog AS $$
DECLARE normalized text;
BEGIN
    IF value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$' THEN
        RAISE EXCEPTION 'session timestamp must be UTC' USING ERRCODE = '23514';
    END IF;
    normalized := regexp_replace(value, '(\.[0-9]{3})[0-9]+Z$', '\1Z');
    -- ISO year zero is PostgreSQL's 1 BC, not an invalid timestamp.
    IF starts_with(normalized, '0000-') THEN
        normalized := '0001-' || substr(normalized, 6) || ' BC';
    END IF;
    RETURN normalized::timestamptz;
END;
$$;

-- Timestamp casts are deliberately in a trigger, not a falsely IMMUTABLE function.
-- Domain schemas and state-transition policy remain in TypeScript.
CREATE FUNCTION hub_metadata.prepare_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hub_metadata AS $$
DECLARE
    doc jsonb;
    field_name text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.namespace IS DISTINCT FROM OLD.namespace OR NEW.key IS DISTINCT FROM OLD.key THEN
            RAISE EXCEPTION 'record identity is immutable' USING ERRCODE = '23514';
        END IF;
        NEW.etag := gen_random_uuid();
        NEW.revision := OLD.revision + 1;
        NEW.uploaded_at := clock_timestamp();
    ELSE
        -- Tokens are new even when an importer supplies the source ETag elsewhere.
        NEW.etag := gen_random_uuid();
        NEW.revision := 1;
    END IF;

    NEW.session_id := NULL;
    NEW.project_id := NULL;
    NEW.notebook_id := NULL;
    NEW.user_id := NULL;
    NEW.session_status := NULL;
    NEW.session_mode := NULL;
    NEW.session_started_at := NULL;
    NEW.session_last_heartbeat := NULL;
    NEW.session_expires_at := NULL;
    NEW.session_authorization_expires_at := NULL;
    NEW.session_sandbox_id := NULL;
    NEW.session_reclaimed_at := NULL;

    IF starts_with(NEW.key, '_system/sessions/') THEN
        doc := convert_from(NEW.body, 'UTF8')::jsonb;
        IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'session record must be an object' USING ERRCODE = '23514';
        END IF;
        FOREACH field_name IN ARRAY ARRAY[
            'session_id', 'project_id', 'notebook_id', 'user_id',
            'status', 'started_at', 'last_heartbeat'
        ] LOOP
            IF jsonb_typeof(doc -> field_name) IS DISTINCT FROM 'string'
                OR length(doc ->> field_name) = 0 THEN
                RAISE EXCEPTION 'missing or invalid session projection field: %', field_name
                    USING ERRCODE = '23514';
            END IF;
        END LOOP;
        NEW.session_id := doc ->> 'session_id';
        NEW.project_id := doc ->> 'project_id';
        NEW.notebook_id := doc ->> 'notebook_id';
        NEW.user_id := doc ->> 'user_id';
        IF NEW.key <> '_system/sessions/' || NEW.project_id || '/' || NEW.session_id || '.json'
            OR position('/' IN NEW.project_id) > 0 OR position('/' IN NEW.session_id) > 0 THEN
            RAISE EXCEPTION 'session key does not match payload identity' USING ERRCODE = '23514';
        END IF;
        NEW.session_status := doc ->> 'status';
        -- Keep absence as NULL; sessionMode() in core owns the legacy default.
        NEW.session_mode := doc ->> 'mode';
        FOREACH field_name IN ARRAY ARRAY[
            'started_at', 'last_heartbeat', 'expires_at',
            'authorization_expires_at', 'sandbox_reclaimed_at'
        ] LOOP
            IF doc ? field_name AND (
                jsonb_typeof(doc -> field_name) IS DISTINCT FROM 'string'
                OR (doc ->> field_name) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$'
            ) THEN
                RAISE EXCEPTION 'session timestamp must be UTC: %', field_name USING ERRCODE = '23514';
            END IF;
        END LOOP;
        NEW.session_started_at := hub_metadata.session_time(doc ->> 'started_at');
        NEW.session_last_heartbeat := hub_metadata.session_time(doc ->> 'last_heartbeat');
        NEW.session_expires_at := hub_metadata.session_time(doc ->> 'expires_at');
        NEW.session_authorization_expires_at := hub_metadata.session_time(doc ->> 'authorization_expires_at');
        NEW.session_sandbox_id := doc ->> 'sandbox_id';
        NEW.session_reclaimed_at := hub_metadata.session_time(doc ->> 'sandbox_reclaimed_at');
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER prepare_record BEFORE INSERT OR UPDATE ON hub_metadata.records
    FOR EACH ROW EXECUTE FUNCTION hub_metadata.prepare_record();

CREATE UNIQUE INDEX records_session_identity
    ON hub_metadata.records(namespace, project_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX records_sessions_user
    ON hub_metadata.records(namespace, user_id, session_status, key) WHERE session_id IS NOT NULL;
CREATE INDEX records_sessions_notebook
    ON hub_metadata.records(namespace, project_id, notebook_id, session_status, key)
    WHERE session_id IS NOT NULL;
CREATE INDEX records_sessions_heartbeat
    ON hub_metadata.records(namespace, session_last_heartbeat, key) WHERE session_id IS NOT NULL;
CREATE INDEX records_sessions_expiry
    ON hub_metadata.records(namespace, session_expires_at, key) WHERE session_expires_at IS NOT NULL;
CREATE INDEX records_sessions_authorization_expiry
    ON hub_metadata.records(namespace, session_authorization_expires_at, key)
    WHERE session_authorization_expires_at IS NOT NULL;
CREATE INDEX records_sessions_unreclaimed
    ON hub_metadata.records(namespace, project_id, key)
    WHERE session_sandbox_id IS NOT NULL AND session_reclaimed_at IS NULL;

-- Permanent rows serialize short SQL units of work. They are not durable leases.
CREATE TABLE hub_metadata.scopes (
    namespace text COLLATE "C" NOT NULL REFERENCES hub_metadata.deployments(namespace),
    scope text COLLATE "C" NOT NULL CHECK (octet_length(scope) BETWEEN 1 AND 1024),
    PRIMARY KEY(namespace, scope)
);

-- Backend transfer progress is distinct from domain MigrationService receipts.
CREATE TABLE hub_metadata.transfers (
    namespace text COLLATE "C" NOT NULL REFERENCES hub_metadata.deployments(namespace),
    id uuid NOT NULL,
    direction text NOT NULL CHECK (direction IN ('bucket_to_sql', 'sql_to_bucket')),
    state text NOT NULL CHECK (state IN ('copying', 'checking', 'ready', 'activated', 'failed')),
    source_epoch bigint NOT NULL CHECK (source_epoch > 0),
    target_epoch bigint NOT NULL CHECK (target_epoch > source_epoch),
    manifest_version integer NOT NULL CHECK (manifest_version > 0),
    cursor jsonb,
    scan_generation bigint NOT NULL DEFAULT 1 CHECK (scan_generation > 0),
    lease_id uuid,
    lease_until timestamptz,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(namespace, id),
    CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
CREATE UNIQUE INDEX transfers_one_pending ON hub_metadata.transfers(namespace)
    WHERE state IN ('copying', 'checking', 'ready');

CREATE TABLE hub_metadata.transfer_items (
    namespace text COLLATE "C" NOT NULL,
    transfer_id uuid NOT NULL,
    key text COLLATE "C" NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 1024),
    source_etag text,
    source_uploaded_at timestamptz,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    target_etag text NOT NULL,
    seen_generation bigint NOT NULL CHECK (seen_generation > 0),
    checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(namespace, transfer_id, key),
    FOREIGN KEY(namespace, transfer_id) REFERENCES hub_metadata.transfers(namespace, id)
);

REVOKE ALL ON SCHEMA hub_metadata FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA hub_metadata FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hub_metadata FROM PUBLIC;
