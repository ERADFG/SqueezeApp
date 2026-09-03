-- ============================================================
-- FIX: unblocking someone should NOT re-follow them
-- ============================================================
-- profile_extras.sql shipped a trg_block_delete trigger that
-- re-inserted a follows row the moment a block row was deleted,
-- on the theory that "the product wants" auto-refollow on unblock.
-- It doesn't — real behavior (matching X/Twitter, and what people
-- actually expect) is: unblocking just lifts the block. It does not
-- make you follow that person again; you have to follow them again
-- yourself if you want to.
--
-- This drops that trigger and its function. The block->unfollow
-- trigger (trg_block_insert / handle_block_insert, which drops any
-- existing follow either direction the moment you block someone) is
-- untouched — that part was correct.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- ============================================================

drop trigger if exists trg_block_delete on public.blocks;
drop function if exists public.handle_block_delete();
