-- Work-product title, URL and state are visible to the formal QA reviewer.
-- A timestamp-only refresh is not review evidence and must not invalidate a
-- review snapshot. Compare every other column so future evidence fields are
-- covered without maintaining a list of column names here.
CREATE FUNCTION paperclip_bump_issue_revision_from_work_product()
RETURNS trigger AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(OLD) - 'updated_at') = (to_jsonb(NEW) - 'updated_at') THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    affected := array_append(affected, OLD.issue_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    affected := array_append(affected, NEW.issue_id);
  END IF;
  PERFORM id FROM issues WHERE id = ANY(affected) ORDER BY id FOR UPDATE;
  UPDATE issues SET revision = revision WHERE id = ANY(affected);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER paperclip_issue_work_products_revision_trigger
BEFORE INSERT OR UPDATE OR DELETE ON issue_work_products
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_work_product();
