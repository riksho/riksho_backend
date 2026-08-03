-- Migration: 017_user_contacts.sql
-- Description: Table for storing user saved contacts for booking rides for others.

CREATE TABLE IF NOT EXISTS user_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, phone)
);

-- Enable RLS
ALTER TABLE user_contacts ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view their own contacts" ON user_contacts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own contacts" ON user_contacts
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own contacts" ON user_contacts
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own contacts" ON user_contacts
    FOR DELETE USING (auth.uid() = user_id);
