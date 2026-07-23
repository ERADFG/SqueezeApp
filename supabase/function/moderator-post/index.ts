// supabase/functions/moderate-post/index.ts
// -----------------------------------------------------------------------
// Supabase Edge Function, invoked by a Database Webhook on INSERT to your
// posts/comments tables. This is the piece that actually closes the gap:
// moderation-guard.js can be skipped (disable JS, or POST straight to
// Supabase's REST API with a client's own anon key) — this cannot, because
// it runs on Supabase's servers as part of the write path, not the poster's
// browser.
//
// Setup:
//   1. supabase functions deploy moderate-post
//   2. Database > Webhooks > New webhook
//        Table: posts (repeat for comments)
//        Events: INSERT
//        Type: HTTP Request -> this function's URL
//   3. Run the SQL in schema.sql (adds a `status` column + quarantine table)
//   4. Your app should only ever SELECT posts where status = 'published'
//      (enforce this with a Postgres RLS policy, not just app-side filtering)
// -----------------------------------------------------------------------

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VIOLENCE_TERMS = [
  "rape", "raping", "raped",
  "molest", "molesting", "molested",
  "sexually abuse", "sexually abusing", "sexually assaulted",
  "have sex with", "having sex with",
];

const MINOR_TERMS = [
  "kid", "kids", "child", "children",
  "minor", "minors", "toddler", "infant", "baby",
  "underage", "preteen", "pre-teen",
];

const TEXT_POLICY: Record<string, { weight: number; terms: string[] }> = {
  sexualExplicit: { weight: 3, terms: ["porn", "pornhub", "xxx video", "nude pics", "sex tape", "onlyfans link"] },
  drugs: { weight: 2, terms: ["heroin", "fentanyl", "meth", "cocaine", "mdma", "buy weed"] },
  illegalTransactions: { weight: 3, terms: ["stolen credit card", "ssn for sale", "fake id", "counterfeit money", "hacked account"] },
  weapons: { weight: 3, terms: ["buy gun no background check", "untraceable firearm", "homemade explosive"] },
};

function normalize(input: string): string {
  if (!input) return "";
  let text = input.toLowerCase();
  text = text.replace(/[013457@$!+]/g, (ch) =>
    ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "+": "t" }[ch] || ch)
  );
  text = text.replace(/([a-z])[\s._\-*]+(?=[a-z])/g, "$1");
  text = text.replace(/([a-z])\1{2,}/g, "$1");
  return text;
}

function checkSevere(rawText: string) {
  const n = normalize(rawText || "");
  const hasViolence = VIOLENCE_TERMS.some((t) => n.includes(normalize(t)));
  const hasMinor = MINOR_TERMS.some((t) => n.includes(normalize(t)));
  return hasViolence && hasMinor;
}

function checkPolicy(rawText: string) {
  const n = normalize(rawText || "");
  const hits: Record<string, string[]> = {};
  let score = 0;
  for (const [category, { weight, terms }] of Object.entries(TEXT_POLICY)) {
    const matched = terms.filter((t) => n.includes(normalize(t)));
    if (matched.length) {
      hits[category] = matched;
      score += matched.length * weight;
    }
  }
  return { score, hits };
}

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // service role — required to bypass RLS and act as moderator
  );

  const payload = await req.json();
  // Database Webhook payload shape: { type: 'INSERT', table, record, schema }
  const { table, record } = payload;
  const text: string = record.content ?? record.text ?? "";
  const rowId = record.id;

  const severe = checkSevere(text);
  const { score, hits } = checkPolicy(text);

  let status: "published" | "blocked" | "quarantined";
  if (severe) {
    status = "quarantined";
  } else if (score >= 4) {
    status = "blocked";
  } else {
    status = "published";
  }

  // Flip the row's status. Your RLS policy for public SELECT should only
  // allow status = 'published', so anything else is invisible to readers
  // immediately — no race window where the bad post is briefly live.
  await supabase.from(table).update({ status }).eq("id", rowId);

  if (status !== "published") {
    await supabase.from("moderation_queue").insert({
      table_name: table,
      row_id: rowId,
      content: text,
      severity: severe ? "severe" : "standard",
      reasons: severe ? ["explicit statement re: sexual violence against a minor"] : Object.keys(hits),
      score,
      status: "pending_review",
      // severe items need a human to decide on NCMEC CyberTipline reporting —
      // see README.md. This is not something to auto-report without review,
      // but it should never sit unreviewed either.
      requires_urgent_review: severe,
    });
  }

  return new Response(JSON.stringify({ status }), {
    headers: { "Content-Type": "application/json" },
  });
});