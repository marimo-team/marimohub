ALTER TABLE hub_metadata.transfers DROP CONSTRAINT transfers_state_check;
ALTER TABLE hub_metadata.transfers ADD CONSTRAINT transfers_state_check
    CHECK (state IN ('copying', 'checking', 'ready', 'activated'));
