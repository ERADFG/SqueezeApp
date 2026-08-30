// scripts/load-disposable-domains.mjs
//
// One-time (or occasionally re-run) loader: pushes data/disposable-email-
// domains.txt into the disposable_email_domains table. Re-running is safe
// (upsert). Run this after applying supabase/moderation_pipeline.sql, and
// re-run every few months to pick up newly-added throwaway domains from
// the upstream list.
//
//   node scripts/load-disposable-domains.mjs
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment
// (same values you already use for other admin scripts).

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const domains = fs
  .readFileSync(new URL('../data/disposable-email-domains.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((d) => d.trim().toLowerCase())
  .filter((d) => d && !d.startsWith('#'));

console.log(`Loading ${domains.length} disposable email domains...`);

const chunkSize = 1000;
for (let i = 0; i < domains.length; i += chunkSize) {
  const chunk = domains.slice(i, i + chunkSize).map((domain) => ({ domain }));
  const { error } = await supabase.from('disposable_email_domains').upsert(chunk, { onConflict: 'domain' });
  if (error) {
    console.error('Chunk failed:', error);
    process.exit(1);
  }
  console.log(`  ${Math.min(i + chunkSize, domains.length)}/${domains.length}`);
}

console.log('Done.');
