-- The audit trail is append-only: reject UPDATE and DELETE on tool_calls and approvals at the
-- database, so no code path (or a hand-run query from the app role) can rewrite history.
CREATE FUNCTION opsharness_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tool_calls_append_only BEFORE UPDATE OR DELETE ON "tool_calls"
  FOR EACH ROW EXECUTE FUNCTION opsharness_reject_mutation();

CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION opsharness_reject_mutation();
