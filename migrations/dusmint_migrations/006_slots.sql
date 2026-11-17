-- =============================================================================
-- 006_slots.sql
-- Delivery slot windows per cluster
-- Morning (7-10 am) and Evening (5-8 pm) with cutoff times and capacity
-- =============================================================================

CREATE TABLE slots (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cluster_id  UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    slot_date   DATE NOT NULL,
    start_time  TIME NOT NULL,           -- e.g. '07:00'
    end_time    TIME NOT NULL,           -- e.g. '10:00'
    cutoff_time TIMESTAMPTZ NOT NULL,    -- Last moment to place an order for this slot
    capacity    INTEGER NOT NULL DEFAULT 50,   -- Max orders for this slot
    booked      INTEGER NOT NULL DEFAULT 0,    -- Current booking count
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT slot_times_valid CHECK (start_time < end_time),
    CONSTRAINT slot_capacity_valid CHECK (booked <= capacity),
    UNIQUE (cluster_id, slot_date, start_time)
);

COMMENT ON TABLE slots IS 'Delivery time windows per cluster per day';
COMMENT ON COLUMN slots.cutoff_time IS 'Full timestamp of the last moment an order can be placed for this slot';
COMMENT ON COLUMN slots.booked IS 'Number of orders currently booked in this slot';

-- RLS: slots are public read (customers need to see available slots)
ALTER TABLE slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY slots_select ON slots FOR SELECT USING (true);
