-- Row locking requires UPDATE privilege. Keep that privilege with the schema owner.
CREATE FUNCTION hub_metadata.guard_deployment(
    expected_namespace text, expected_epoch bigint, expected_artifact_store uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE deployment hub_metadata.deployments%ROWTYPE;
BEGIN
    SELECT * INTO deployment FROM hub_metadata.deployments
        WHERE namespace = expected_namespace FOR SHARE;
    IF NOT FOUND OR deployment.state <> 'active'
        OR deployment.backend_epoch <> expected_epoch
        OR deployment.artifact_store_id <> expected_artifact_store THEN
        RAISE EXCEPTION 'metadata deployment unavailable' USING ERRCODE = '55000';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION hub_metadata.guard_deployment(text, bigint, uuid) FROM PUBLIC;
