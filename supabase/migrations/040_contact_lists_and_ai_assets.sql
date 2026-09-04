-- ============================================================
-- 040_contact_lists_and_ai_assets
--
-- Contact lists: one contact may belong to many lists. Lists are
-- account-scoped and can be used directly as broadcast audiences.
-- AI assets: account-scoped media library for PDFs, images and videos.
-- PDFs are optionally indexed into the existing AI knowledge base by
-- the application after upload; images/videos are available for the
-- AI agent to send through WhatsApp using the media command protocol.
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_lists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_contact_lists_account ON contact_lists(account_id);

CREATE TABLE IF NOT EXISTS contact_list_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_id UUID NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (list_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_list_members_list ON contact_list_members(list_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_members_contact ON contact_list_members(contact_id);

ALTER TABLE contact_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_list_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_lists_select ON contact_lists;
CREATE POLICY contact_lists_select ON contact_lists FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS contact_lists_insert ON contact_lists;
CREATE POLICY contact_lists_insert ON contact_lists FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS contact_lists_update ON contact_lists;
CREATE POLICY contact_lists_update ON contact_lists FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS contact_lists_delete ON contact_lists;
CREATE POLICY contact_lists_delete ON contact_lists FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS contact_list_members_select ON contact_list_members;
CREATE POLICY contact_list_members_select ON contact_list_members FOR SELECT
  USING (EXISTS (SELECT 1 FROM contact_lists l WHERE l.id = list_id AND is_account_member(l.account_id)));
DROP POLICY IF EXISTS contact_list_members_insert ON contact_list_members;
CREATE POLICY contact_list_members_insert ON contact_list_members FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM contact_lists l WHERE l.id = list_id AND is_account_member(l.account_id, 'admin')));
DROP POLICY IF EXISTS contact_list_members_delete ON contact_list_members;
CREATE POLICY contact_list_members_delete ON contact_list_members FOR DELETE
  USING (EXISTS (SELECT 1 FROM contact_lists l WHERE l.id = list_id AND is_account_member(l.account_id, 'admin')));

DROP TRIGGER IF EXISTS set_updated_at ON contact_lists;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_lists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION public.filter_contacts_by_list(
  p_account_id UUID,
  p_list_id UUID,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (contact JSONB, total_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH matched AS (
    SELECT c.*
    FROM contacts c
    INNER JOIN contact_list_members m ON m.contact_id = c.id
    WHERE c.account_id = p_account_id
      AND m.list_id = p_list_id
      AND (
        NULLIF(trim(p_search), '') IS NULL
        OR c.name ILIKE '%' || trim(p_search) || '%'
        OR c.phone ILIKE '%' || trim(p_search) || '%'
        OR c.email ILIKE '%' || trim(p_search) || '%'
      )
  )
  SELECT to_jsonb(x), count(*) OVER ()
  FROM matched x
  ORDER BY x.created_at DESC
  LIMIT GREATEST(p_limit, 0)
  OFFSET GREATEST(p_offset, 0);
$$;

REVOKE ALL ON FUNCTION public.filter_contacts_by_list(UUID, UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_list(UUID, UUID, TEXT, INTEGER, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_all_contacts_for_account(p_account_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_count INTEGER;
BEGIN
  IF NOT is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  DELETE FROM contacts WHERE account_id = p_account_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_all_contacts_for_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_all_contacts_for_account(UUID) TO authenticated, service_role;

-- ============================================================
-- AI ASSETS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('pdf','image','video')),
  storage_path TEXT NOT NULL,
  extracted_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_assets_account ON ai_assets(account_id, created_at DESC);

ALTER TABLE ai_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_assets_select ON ai_assets;
CREATE POLICY ai_assets_select ON ai_assets FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_assets_insert ON ai_assets;
CREATE POLICY ai_assets_insert ON ai_assets FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_assets_update ON ai_assets;
CREATE POLICY ai_assets_update ON ai_assets FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_assets_delete ON ai_assets;
CREATE POLICY ai_assets_delete ON ai_assets FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON ai_assets;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ai-assets', 'ai-assets', FALSE, 104857600,
  ARRAY[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/3gpp', 'video/quicktime'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS ai_assets_storage_select ON storage.objects;
CREATE POLICY ai_assets_storage_select ON storage.objects FOR SELECT
  USING (
    bucket_id = 'ai-assets' AND
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
    )
  );
DROP POLICY IF EXISTS ai_assets_storage_insert ON storage.objects;
CREATE POLICY ai_assets_storage_insert ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'ai-assets' AND
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner','admin')
        AND p.account_id::text = (storage.foldername(name))[1]
    )
  );
DROP POLICY IF EXISTS ai_assets_storage_delete ON storage.objects;
CREATE POLICY ai_assets_storage_delete ON storage.objects FOR DELETE
  USING (
    bucket_id = 'ai-assets' AND
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner','admin')
        AND p.account_id::text = (storage.foldername(name))[1]
    )
  );
