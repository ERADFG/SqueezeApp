// api.js - Data Fetching & Strict Segregation
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase (Replace with actual env vars)
const supabase = createClient('YOUR_SUPABASE_URL', 'YOUR_SUPABASE_ANON_KEY');

export const fetchThreads = async (boardId) => {
    if (!boardId) throw new Error("CRITICAL: Fetch attempted without board_id context.");

    // Strict Segregation: Every query MUST filter by board_id
    const { data, error } = await supabase
        .from('threads')
        .select('id, title, content, created_at, reply_count')
        .eq('board_id', boardId) // The firewall
        .order('created_at', { ascending: false });

    if (error) console.error(`Error fetching /${boardId}/:`, error);
    return data;
};

export const fetchThreadComments = async (boardId, threadId) => {
    const { data, error } = await supabase
        .from('comments')
        .select('*')
        .match({ board_id: boardId, thread_id: threadId }) // Double-check isolation
        .order('created_at', { ascending: true });
    return data;
};