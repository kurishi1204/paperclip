-- Keep this comparison aligned with the workProducts projection in
-- services/qa-review-tools.ts. Provider sync metadata and timestamps are not
-- visible to the formal QA reviewer and must not invalidate its snapshot.
CREATE FUNCTION paperclip_bump_issue_revision_from_work_product()
RETURNS trigger AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP = 'UPDATE' AND
     ROW(OLD.issue_id, OLD.type, OLD.provider, OLD.title, OLD.url,
         OLD.status, OLD.review_state, OLD.health_status, OLD.is_primary)
     IS NOT DISTINCT FROM
     ROW(NEW.issue_id, NEW.type, NEW.provider, NEW.title, NEW.url,
         NEW.status, NEW.review_state, NEW.health_status, NEW.is_primary) THEN
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
