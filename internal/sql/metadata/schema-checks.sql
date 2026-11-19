-- Run after 001-schema.sql against a disposable database, with ON_ERROR_STOP=1.
-- All fixture data and helpers roll back at the end.
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'assertion failed: %', label;
    END IF;
END;
$$;

SELECT pg_temp.assert_true(
    hub_metadata.session_time('2026-01-01T00:00Z') = '2026-01-01T00:00:00Z'::timestamptz
    AND hub_metadata.session_time('2026-01-01T00:00:01.9999999Z') = '2026-01-01T00:00:01.999Z'::timestamptz
    AND hub_metadata.session_time('0000-01-01T00:00:00Z') = '0001-01-01T00:00:00Z BC'::timestamptz,
    'supported UTC shapes, year zero and JavaScript millisecond truncation');

INSERT INTO hub_metadata.deployments(namespace, backend_epoch, state, artifact_store_id)
VALUES ('check-a', 1, 'active', '11111111-1111-4111-8111-111111111111'),
       ('check-b', 1, 'active', '22222222-2222-4222-8222-222222222222');

INSERT INTO hub_metadata.records(namespace, key, body)
VALUES ('check-a', '_system/identities/test.json', decode('00ff01', 'hex')),
       ('check-b', '_system/identities/test.json', decode('0203', 'hex'));
SELECT pg_temp.assert_true(
    (SELECT encode(body, 'hex') = '00ff01' AND size_bytes = 3
     FROM hub_metadata.records WHERE namespace = 'check-a' AND key = '_system/identities/test.json'),
    'exact bytes, generated size and namespace isolation');

DO $$
DECLARE before_tag uuid; after_tag uuid; rows_changed integer;
BEGIN
    SELECT etag INTO before_tag FROM hub_metadata.records
        WHERE namespace = 'check-a' AND key = '_system/identities/test.json';
    UPDATE hub_metadata.records SET body = decode('abcd', 'hex')
        WHERE namespace = 'check-a' AND key = '_system/identities/test.json' AND etag = before_tag
        RETURNING etag INTO after_tag;
    PERFORM pg_temp.assert_true(after_tag <> before_tag, 'CAS refreshes ETag');
    UPDATE hub_metadata.records SET body = decode('ffff', 'hex')
        WHERE namespace = 'check-a' AND key = '_system/identities/test.json' AND etag = before_tag;
    GET DIAGNOSTICS rows_changed = ROW_COUNT;
    PERFORM pg_temp.assert_true(rows_changed = 0, 'stale CAS rejects');
    PERFORM pg_temp.assert_true(
        (SELECT revision = 2 FROM hub_metadata.records
         WHERE namespace = 'check-a' AND key = '_system/identities/test.json'), 'revision increments');
    DELETE FROM hub_metadata.records WHERE namespace = 'check-a' AND key = '_system/identities/test.json';
    INSERT INTO hub_metadata.records(namespace, key, body)
        VALUES ('check-a', '_system/identities/test.json', decode('abcd', 'hex'));
    PERFORM pg_temp.assert_true(
        (SELECT etag <> after_tag AND revision = 1 FROM hub_metadata.records
         WHERE namespace = 'check-a' AND key = '_system/identities/test.json'), 'delete/recreate has new token');
    INSERT INTO hub_metadata.records(namespace, key, body)
        VALUES ('check-a', '_system/identities/test.json', decode('eeee', 'hex'))
        ON CONFLICT(namespace, key) DO NOTHING;
    GET DIAGNOSTICS rows_changed = ROW_COUNT;
    PERFORM pg_temp.assert_true(rows_changed = 0, 'create-if-absent loser writes nothing');
END;
$$;

INSERT INTO hub_metadata.records(namespace, key, body, uploaded_at)
VALUES ('check-a', '_system/sessions/p1/s1.json', convert_to('{
  "session_id":"s1", "project_id":"p1", "notebook_id":"n1", "user_id":"u1",
  "status":"starting", "started_at":"2026-01-01T00:00:00Z",
  "last_heartbeat":"2026-01-01T00:00:01.123Z", "expires_at":"2026-01-01T01:00:00Z",
  "future_field":{"unknown":true}
}', 'UTF8'), '2026-01-01T00:00:00Z');
SELECT pg_temp.assert_true(
    (SELECT session_id = 's1' AND project_id = 'p1' AND notebook_id = 'n1' AND user_id = 'u1'
        AND session_status = 'starting' AND session_mode IS NULL
        AND session_last_heartbeat = '2026-01-01T00:00:01.123Z'::timestamptz
        AND session_authorization_expires_at IS NULL
        AND uploaded_at = '2026-01-01T00:00:00Z'::timestamptz
     FROM hub_metadata.records WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json'),
    'session projection derives identifiers, dates and missing optional fields');

UPDATE hub_metadata.records SET
    body = convert_to((convert_from(body, 'UTF8')::jsonb ||
        '{"status":"running","mode":"app","sandbox_id":"sandbox-1"}'::jsonb)::text, 'UTF8'),
    session_status = 'forged', user_id = 'forged'
WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json';
SELECT pg_temp.assert_true(
    (SELECT session_status = 'running' AND user_id = 'u1' AND session_mode = 'app'
        AND session_sandbox_id = 'sandbox-1' AND session_reclaimed_at IS NULL
        AND (convert_from(body, 'UTF8')::jsonb -> 'future_field' ->> 'unknown') = 'true'
     FROM hub_metadata.records WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json'),
    'projections cannot be forged and unknown document fields survive');

UPDATE hub_metadata.records SET body = convert_to(
    (convert_from(body, 'UTF8')::jsonb - 'expires_at')::text, 'UTF8')
WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json';
SELECT pg_temp.assert_true(
    (SELECT session_expires_at IS NULL FROM hub_metadata.records
     WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json'),
    'removed deadline clears projection');

DO $$
BEGIN
    BEGIN
        UPDATE hub_metadata.records SET body = convert_to(
            (convert_from(body, 'UTF8')::jsonb || '{"project_id":"other"}')::text, 'UTF8')
        WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json';
        RAISE EXCEPTION 'expected mismatched identity rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE hub_metadata.records SET body = convert_to(
            (convert_from(body, 'UTF8')::jsonb || '{"last_heartbeat":"tomorrow"}')::text, 'UTF8')
        WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json';
        RAISE EXCEPTION 'expected invalid date rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO hub_metadata.records(namespace, key, body)
            VALUES ('check-a', '_system/sessions/p1/bad.json', convert_to('{}', 'UTF8'));
        RAISE EXCEPTION 'expected missing fields rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE hub_metadata.records SET key = 'renamed' WHERE namespace = 'check-a'
            AND key = '_system/sessions/p1/s1.json';
        RAISE EXCEPTION 'expected identity mutation rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO hub_metadata.records(namespace, key, body)
            VALUES ('missing-deployment', 'x', ''::bytea);
        RAISE EXCEPTION 'expected namespace FK rejection';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END;
$$;

INSERT INTO hub_metadata.records(namespace, key, body, session_id, user_id)
VALUES ('check-a', 'other-metadata', ''::bytea, 'forged', 'forged');
SELECT pg_temp.assert_true(
    (SELECT session_id IS NULL AND user_id IS NULL AND size_bytes = 0
     FROM hub_metadata.records WHERE namespace = 'check-a' AND key = 'other-metadata'),
    'non-session projections cleared');

INSERT INTO hub_metadata.transfers(namespace, id, direction, state, source_epoch, target_epoch, manifest_version)
VALUES ('check-a', '33333333-3333-4333-8333-333333333333', 'bucket_to_sql', 'copying', 1, 2, 1);
DO $$
BEGIN
    BEGIN
        INSERT INTO hub_metadata.transfers(namespace, id, direction, state, source_epoch, target_epoch, manifest_version)
        VALUES ('check-a', '44444444-4444-4444-8444-444444444444', 'bucket_to_sql', 'copying', 1, 2, 1);
        RAISE EXCEPTION 'expected concurrent transfer rejection';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        UPDATE hub_metadata.transfers SET lease_id = gen_random_uuid()
        WHERE namespace = 'check-a' AND id = '33333333-3333-4333-8333-333333333333';
        RAISE EXCEPTION 'expected incomplete lease rejection';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;

SAVEPOINT rollback_probe;
INSERT INTO hub_metadata.records(namespace, key, body) VALUES ('check-a', 'rollback-probe', ''::bytea);
ROLLBACK TO SAVEPOINT rollback_probe;
SELECT pg_temp.assert_true(NOT EXISTS (
    SELECT FROM hub_metadata.records WHERE namespace = 'check-a' AND key = 'rollback-probe'
), 'rolled back records are absent');
CREATE ROLE hub_metadata_check_runtime;
GRANT USAGE ON SCHEMA hub_metadata TO hub_metadata_check_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON hub_metadata.records, hub_metadata.scopes TO hub_metadata_check_runtime;
GRANT SELECT ON hub_metadata.deployments, hub_metadata.schema_migrations TO hub_metadata_check_runtime;
GRANT EXECUTE ON FUNCTION hub_metadata.prepare_record(), hub_metadata.session_time(text) TO hub_metadata_check_runtime;
SET LOCAL ROLE hub_metadata_check_runtime;
UPDATE hub_metadata.records SET body = body
WHERE namespace = 'check-a' AND key = '_system/sessions/p1/s1.json';
DO $$
BEGIN
    BEGIN
        UPDATE hub_metadata.deployments SET state = 'frozen' WHERE namespace = 'check-a';
        RAISE EXCEPTION 'expected activation privilege rejection';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        TRUNCATE hub_metadata.records;
        RAISE EXCEPTION 'expected truncate privilege rejection';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DELETE FROM hub_metadata.transfers;
        RAISE EXCEPTION 'expected transfer privilege rejection';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        CREATE TABLE hub_metadata.runtime_ddl_is_forbidden(id integer);
        RAISE EXCEPTION 'expected DDL privilege rejection';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
RESET ROLE;
ROLLBACK;
SELECT 'schema checks passed; fixtures rolled back'  AS result;
