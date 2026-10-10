-- Work-product title, URL and state are visible to the formal QA reviewer.
-- Reuse the issue-row serialization point established by migration 0313 so
-- every writer, including a direct service or database write, invalidates an
-- earlier QA evidence snapshot before the verdict CAS can commit.
CREATE TRIGGER paperclip_issue_work_products_revision_trigger
BEFORE INSERT OR UPDATE OR DELETE ON issue_work_products
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();
