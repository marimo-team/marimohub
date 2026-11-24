-- A shared advisory lock fences the deployment without a row lock, so guarded reads
-- assign no transaction ID and write no WAL. Freeze and activation paths take the same
-- key exclusively before changing deployments.state.
CREATE OR REPLACE FUNCTION hub_metadata.guard_deployment(
    expected_namespace text, expected_epoch bigint, expected_artifact_store uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE deployment record;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(expected_namespace, 0));
    SELECT state, backend_epoch, artifact_store_id INTO deployment
        FROM hub_metadata.deployments WHERE namespace = expected_namespace;
    IF NOT FOUND OR deployment.state <> 'active'
        OR deployment.backend_epoch <> expected_epoch
        OR deployment.artifact_store_id <> expected_artifact_store THEN
        RAISE EXCEPTION 'metadata deployment unavailable' USING ERRCODE = '55000';
    END IF;
END;
$$;
