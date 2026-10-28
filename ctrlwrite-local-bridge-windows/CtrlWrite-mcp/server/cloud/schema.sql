CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY, name text NOT NULL, email text UNIQUE, phone text UNIQUE,
    password_hash text NOT NULL, auth_version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY, owner_id uuid NOT NULL UNIQUE REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS canvases (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), revision bigint NOT NULL DEFAULT 0,
    document jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), encrypted text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assets (
    id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
    object_key text NOT NULL UNIQUE, name text NOT NULL, mime text NOT NULL, bytes integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library (
    id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
    kind text NOT NULL CHECK (kind IN ('skill', 'constraint')), name text NOT NULL,
    content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(workspace_id, kind, name)
);
CREATE TABLE IF NOT EXISTS jobs (
    id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    payload text NOT NULL, result jsonb, error text, lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(workspace_id, status, created_at);
CREATE TABLE IF NOT EXISTS mcp_tokens (
    hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
    scopes text[] NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
    action text NOT NULL, resource_id text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_owner ON workspaces;
CREATE POLICY workspace_owner ON workspaces USING (owner_id::text = current_setting('app.user_id', true)) WITH CHECK (owner_id::text = current_setting('app.user_id', true));
DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['canvases', 'settings', 'assets', 'library', 'jobs', 'mcp_tokens', 'audit_logs'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('DROP POLICY IF EXISTS workspace_access ON %I', table_name);
        EXECUTE format('CREATE POLICY workspace_access ON %I USING (EXISTS (SELECT 1 FROM workspaces WHERE id = workspace_id)) WITH CHECK (EXISTS (SELECT 1 FROM workspaces WHERE id = workspace_id))', table_name);
    END LOOP;
END $$;
