CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_owner_raw_captures (
  company_id uuid NOT NULL,
  space_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  owner_user_id text NOT NULL,
  body_sha256 text NOT NULL,
  comment_updated_at timestamptz NOT NULL,
  raw_path text NOT NULL,
  policy_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'verified', 'hold')),
  hold_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, space_id, comment_id)
);
