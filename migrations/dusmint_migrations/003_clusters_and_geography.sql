-- =============================================================================
-- 003_clusters_and_geography.sql
-- Service clusters defining the delivery zones
-- Each cluster is a ~2 km radius circle around a centre point
-- =============================================================================

CREATE TYPE cluster_status AS ENUM ('active', 'paused', 'closed');

CREATE TABLE clusters (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,              -- "Salt Lake Sector V", "Park Street"
    city        TEXT NOT NULL,              -- "Kolkata"
    centre      GEOGRAPHY(POINT, 4326) NOT NULL,  -- Centre of the cluster
    centre_lat  DOUBLE PRECISION NOT NULL,
    centre_lng  DOUBLE PRECISION NOT NULL,
    radius_m    INTEGER NOT NULL DEFAULT 2000,  -- Service radius in metres
    status      cluster_status NOT NULL DEFAULT 'active',
    timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE clusters IS 'Service delivery clusters, each ~2 km radius';
COMMENT ON COLUMN clusters.radius_m IS 'Service radius in metres from the centre point';

CREATE TRIGGER clusters_updated_at
    BEFORE UPDATE ON clusters
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Add cluster_id foreign key to addresses now that clusters table exists
ALTER TABLE addresses
    ADD CONSTRAINT addresses_cluster_fk
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL;

-- RLS: clusters are public read (anyone can check serviceability)
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
CREATE POLICY clusters_select ON clusters FOR SELECT USING (true);
