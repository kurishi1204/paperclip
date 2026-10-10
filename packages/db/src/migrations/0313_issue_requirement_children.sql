-- The issue row is the serialization point for native requirement material.
-- BEFORE triggers acquire it before the child tuple is changed, so a reader
-- holding FOR UPDATE on issues can freeze a coherent child snapshot.
CREATE FUNCTION paperclip_bump_issue_revision_from_child()
RETURNS trigger AS $$
DECLARE
  affected uuid[] := ARRAY[]::uuid[];
  row_issue_id uuid;
BEGIN
  -- Attribution backfills during GET do not change a comment's instructions.
  IF TG_TABLE_NAME = 'issue_comments' AND TG_OP = 'UPDATE' AND
     (to_jsonb(OLD) - ARRAY['derived_author_agent_id', 'derived_created_by_run_id',
                             'derived_author_source', 'updated_at']) =
     (to_jsonb(NEW) - ARRAY['derived_author_agent_id', 'derived_created_by_run_id',
                             'derived_author_source', 'updated_at']) THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'documents' THEN
    -- Only a linked document is part of an issue request. Its current body,
    -- metadata, and lock state live on documents, not document_revisions.
    SELECT issue_id INTO row_issue_id
      FROM issue_documents WHERE document_id = NEW.id;
    IF row_issue_id IS NOT NULL THEN
      affected := array_append(affected, row_issue_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'assets' THEN
    SELECT issue_id INTO row_issue_id
      FROM issue_attachments WHERE asset_id = NEW.id;
    IF row_issue_id IS NOT NULL THEN
      affected := array_append(affected, row_issue_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'issue_relations' THEN
    IF TG_OP <> 'INSERT' THEN
      affected := array_append(affected, OLD.issue_id);
      affected := array_append(affected, OLD.related_issue_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      affected := array_append(affected, NEW.issue_id);
      affected := array_append(affected, NEW.related_issue_id);
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      affected := array_append(affected, OLD.issue_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      affected := array_append(affected, NEW.issue_id);
    END IF;
  END IF;

  -- Lock both ends of a relation in stable order before bumping either.
  PERFORM id FROM issues WHERE id = ANY(affected) ORDER BY id FOR UPDATE;
  UPDATE issues SET revision = revision WHERE id = ANY(affected);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER paperclip_issue_comments_revision_trigger
BEFORE INSERT OR UPDATE OR DELETE ON issue_comments
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();--> statement-breakpoint
CREATE TRIGGER paperclip_issue_documents_revision_trigger
BEFORE INSERT OR UPDATE OR DELETE ON issue_documents
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();--> statement-breakpoint
CREATE TRIGGER paperclip_documents_issue_revision_trigger
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();--> statement-breakpoint
CREATE TRIGGER paperclip_issue_relations_revision_trigger
BEFORE INSERT OR UPDATE OR DELETE ON issue_relations
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();--> statement-breakpoint
CREATE TRIGGER paperclip_issue_attachments_revision_trigger
BEFORE INSERT OR UPDATE OR DELETE ON issue_attachments
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();--> statement-breakpoint
CREATE TRIGGER paperclip_assets_issue_revision_trigger
BEFORE UPDATE ON assets
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();--> statement-breakpoint
CREATE TRIGGER paperclip_issue_labels_revision_trigger
BEFORE INSERT OR UPDATE OR DELETE ON issue_labels
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_revision_from_child();
