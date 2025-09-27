CREATE TABLE memories (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    memory TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
