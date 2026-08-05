-- Add driver_locations to realtime publication for B4 (live tracking via Postgres Changes)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'driver_locations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_locations;
  END IF;
END $$;
