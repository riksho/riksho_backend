-- Create push_history table to track sent broadcast notifications
CREATE TABLE IF NOT EXISTS public.push_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    image_url TEXT,
    target TEXT NOT NULL, -- e.g., 'all_users', 'riders', 'drivers'
    sent_by UUID REFERENCES auth.users(id),
    fcm_message_id TEXT, -- ID returned by Firebase Admin SDK
    delivery_count INT DEFAULT 0,
    sent_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create push_tokens table to store device FCM tokens
CREATE TABLE IF NOT EXISTS public.push_tokens (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform TEXT NOT NULL,
    token_type TEXT DEFAULT 'fcm',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.push_history ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated admins
CREATE POLICY "Admins can view push history" ON public.push_history
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.id = auth.uid() AND u.role = 'admin'
        )
    );

-- Allow insert access for backend service role only (bypasses RLS)
-- No INSERT policy needed because the backend uses the service_role key to insert.
