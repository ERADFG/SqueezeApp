#!/usr/bin/env python3
"""
InteractInk — Automatic Blog Generator
========================================
Runs forever, or once via --once. Every cycle it:

  1. Picks a topic angle from TOPIC_POOL, then asks the model for ONE
     specific, realistic search query a reader would actually type
     (a "target keyword") plus the search intent behind it (informational,
     how-to, comparison, etc). This is a separate step from writing the
     post, because it's what makes the post actually target search intent
     instead of just riffing on a broad topic.
  2. Asks the model to write a full, original post that directly answers
     that query: an intro that gets to the point immediately, 5-7 solid
     body sections, and a short FAQ block covering related questions a
     reader (or Google's "People also ask") would have. The system prompt
     bans the stock AI-blog phrases and structures that make posts read as
     obviously machine-generated, and requires concrete specifics over
     generic statements.
  3. Looks up a real, commercially-reusable image for the post via the
     Openverse API (openverse.org — a Creative-Commons image search run by
     WordPress.org, no API key required) and embeds it as a hero image
     with proper attribution, which is required by the CC licenses these
     images are under.
  4. Renders it into an HTML page using the EXACT same UI shell as the
     rest of the site (sidebar nav, right widgets, mobile tab bar, footer,
     theme support, ads/analytics tags) — pulled straight from your
     existing article template. Adds Article + FAQPage JSON-LD structured
     data for search engines.
  5. Saves it into a `blogs/` folder as blogs/<slug>.html, regenerates
     blogs/index.html (master list, newest first), and adds a one-time
     "Full Archive" link into blog.html.

USAGE
-----
    export GROQ_API_KEY="gsk_...your key..."
    python3 auto_blog.py                      # run forever, every INTERVAL_SECONDS
    python3 auto_blog.py --once               # generate a single post and exit (good for testing)
    python3 auto_blog.py --interval 21600      # every 6 hours instead
    python3 auto_blog.py --site-dir /path/to/InteractInk_app

Requires only the Python standard library — nothing to pip install.
"""

import argparse
import json
import os
import random
import re
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# --------------------------------------------------------------------------
# CONFIG
# --------------------------------------------------------------------------

# Groq hosts several open-weight models behind an OpenAI-compatible API.
# Check https://console.groq.com/docs/models for the current lineup and
# swap this if the model is retired or you want a different quality/speed
# tradeoff — the code below works with any chat-completions-style model.
MODEL = "llama-3.3-70b-versatile"
API_URL = "https://api.groq.com/openai/v1/chat/completions"

# Openverse (openverse.org) — free, no API key, aggregates openly-licensed
# images from Flickr, Wikimedia Commons, museums, etc. We filter to
# licenses that permit commercial use and modification, and we always
# render attribution (required by CC licenses).
IMAGE_API_URL = "https://api.openverse.org/v1/images/"

# Quality > quantity. Posting every 5 minutes produces thin, repetitive,
# low-value pages that both readers and search engines discount — and
# with only ~20 topics in the pool you'd exhaust real angles in under two
# hours. A few well-researched posts a day is far better for actual
# search visibility. Override with --interval if you disagree.
DEFAULT_INTERVAL_SECONDS = 5 * 60  # 5 minutes (only matters for local --forever loop;
                                     # the GitHub Actions cron schedule below is what
                                     # actually controls cadence when running unattended)
MAX_ATTEMPTS_PER_CYCLE = 3
RETRY_BACKOFF_SECONDS = 30

# Hard rule: every published post must be 800-2,000+ words. MIN_WORD_COUNT
# is enforced (too-short output is rejected and retried); MAX_WORD_COUNT is
# just a soft target passed to the model so posts don't ramble past the
# point of being useful — going over it is fine and not rejected.
MIN_WORD_COUNT = 800
TARGET_WORD_COUNT = 1300

SITE_NAME = "InteractInk"
SITE_URL = "https://interactink.vercel.app"
GA_ID = "G-527BWKF63G"
ADSENSE_CLIENT = "ca-pub-9357677827244243"
SITE_VERIFICATION = "DOvTKyh77YUQreg4Dg6SaL1wEM33Da783l6lqsLek7Q"

TOPIC_POOL = [
    "anonymous posting and free speech online",
    "the psychology of anonymity in online discussion",
    "moderation strategies for anonymous communities",
    "how imageboards differ from social media feeds",
    "digital privacy habits for everyday internet users",
    "the history and evolution of internet forum culture",
    "why anonymous communities foster different conversations than named ones",
    "tripcodes, handles, and pseudonymous identity online",
    "how to spot and avoid online scams on anonymous platforms",
    "the tradeoffs between anonymity and accountability online",
    "internet culture and meme origins from anonymous boards",
    "practical opsec tips for staying private online",
    "how anonymous boards handle spam and bad actors",
    "the difference between anonymity and privacy",
    "why niche communities thrive outside algorithmic feeds",
    "the ethics of anonymous whistleblowing and disclosure",
    "how thread-based discussion differs from comment sections",
    "building trust in a community with no user accounts",
    "the role of anonymous boards in early internet history",
    "digital minimalism and stepping back from tracked platforms",
]

# Phrases that instantly signal "generic AI blog post" — banned outright.
BANNED_PHRASES = [
    "in today's digital age", "in the digital age", "in an increasingly",
    "navigate the landscape", "navigate the world of", "delve into",
    "dive into", "tapestry", "unlock the", "unleash the", "game-changer",
    "game changer", "it is important to note", "it's important to note",
    "in conclusion", "in summary", "furthermore", "moreover", "additionally,",
    "as we've explored", "as we've seen", "at the end of the day",
    "when it comes to", "in the world of", "the world of online",
    "whether you're a", "let's explore", "let's dive", "ever-evolving",
    "in this day and age", "plays a crucial role", "plays a vital role",
    "cannot be overstated", "a testament to", "underscores the importance",
]

# --------------------------------------------------------------------------
# PATHS
# --------------------------------------------------------------------------

def resolve_site_dir(cli_value: str) -> str:
    if cli_value:
        return os.path.abspath(cli_value)
    # default: the folder this script lives in
    return os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------
# GROQ (OPENAI-COMPATIBLE) API CALL
# --------------------------------------------------------------------------

def call_groq(system_prompt: str, user_prompt: str, max_tokens: int = 4000) -> str:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GROQ_API_KEY environment variable is not set. "
            "Get a key from https://console.groq.com/keys and run:\n"
            "  export GROQ_API_KEY=gsk_...\n"
            "(on Windows: set GROQ_API_KEY=gsk_...)"
        )

    body = json.dumps({
        "model": MODEL,
        "max_tokens": max_tokens,
        "temperature": 0.85,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Groq API returned HTTP {e.code}: {detail}") from e

    choices = data.get("choices", [])
    if not choices:
        raise RuntimeError(f"Groq API returned no choices: {data}")
    return choices[0]["message"]["content"].strip()


# --------------------------------------------------------------------------
# IMAGE LOOKUP (Openverse — free, no key, CC-licensed images)
# --------------------------------------------------------------------------

def fetch_image_for_post(query: str):
    """Find a real, commercially-reusable image for the post.

    Returns a dict {url, alt, attribution_html} or None if nothing usable
    was found (the post still publishes fine without a hero image).
    """
    try:
        params = urllib.parse.urlencode({
            "q": query,
            "license_type": "commercial,modification",
            "page_size": 12,
            "mature": "false",
        })
        req = urllib.request.Request(
            f"{IMAGE_API_URL}?{params}",
            headers={"User-Agent": f"{SITE_NAME}-auto-blog/1.0 (+{SITE_URL})"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        results = [r for r in data.get("results", []) if r.get("url")]
        random.shuffle(results)

        for r in results:
            title = (r.get("title") or query).strip()[:120]
            creator = (r.get("creator") or "Unknown").strip()
            source = r.get("foreign_landing_url") or r.get("source")
            license_name = (r.get("license") or "").upper()
            license_version = r.get("license_version") or ""
            license_str = f"{license_name} {license_version}".strip()

            attribution_bits = [f'&#8220;{title}&#8221; by {creator}']
            if license_str:
                attribution_bits.append(f'({license_str})')
            attribution = " ".join(attribution_bits)
            if source:
                attribution += f' &mdash; <a href="{source}" class="inline-link" rel="noopener nofollow" target="_blank">source</a>'

            return {
                "url": r["url"],
                "alt": title,
                "attribution": attribution,
            }
    except Exception as e:
        log(f"Image lookup failed for '{query}' ({e}); publishing without a hero image.")
    return None


# --------------------------------------------------------------------------
# STEP 1 — TARGET KEYWORD / SEARCH INTENT
# --------------------------------------------------------------------------

def strip_json_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"```$", "", text.strip())
    return text.strip()


def generate_target_keyword(recent_keywords):
    """Pick one specific, realistic search query to target, distinct from
    everything already covered. This is deliberately a separate call from
    writing the post: it forces the model to commit to a concrete reader
    intent before it starts writing, instead of writing something vague
    enough to fit any topic."""
    topic_hint = random.choice(TOPIC_POOL)
    avoid_list = "\n".join(f"- {k}" for k in recent_keywords[-60:]) or "(none yet)"

    system_prompt = (
        f"You are an SEO/content strategist for {SITE_NAME}, an anonymous "
        "imageboard/forum (no accounts, thread-based discussion). You pick "
        "specific search queries real people type into Google — not broad "
        "topics. Output ONLY valid JSON, no markdown fences, no commentary."
    )
    user_prompt = f"""Broad topic area to work within: "{topic_hint}"

Already-targeted queries — pick something meaningfully different, not a rewording of any of these:
{avoid_list}

Return ONLY a JSON object:
{{
  "keyword": "a specific, realistic search query a person would type (4-8 words, lowercase, no quotes)",
  "intent": "one of: informational, how-to, comparison, definitional, troubleshooting",
  "angle": "one sentence describing the specific angle the article should take to genuinely satisfy that query, more specific than the broad topic",
  "image_query": "2-4 word plain-English visual search term for a stock/CC photo that would suit this article as a hero image (e.g. 'person typing laptop dark room', 'padlock digital security') — concrete and photographable, not abstract"
}}"""

    raw = call_groq(system_prompt, user_prompt, max_tokens=500)
    data = json.loads(strip_json_fences(raw))
    for key in ("keyword", "intent", "angle", "image_query"):
        if key not in data or not data[key]:
            raise ValueError(f"Keyword-planning response missing field: {key}")
    return data


# --------------------------------------------------------------------------
# STEP 2 — POST GENERATION
# --------------------------------------------------------------------------

def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text[:70] or "post"


def unique_slug(base_slug: str, existing_slugs: set) -> str:
    if base_slug not in existing_slugs:
        return base_slug
    n = 2
    while f"{base_slug}-{n}" in existing_slugs:
        n += 1
    return f"{base_slug}-{n}"


def word_count(post) -> int:
    parts = [post.get("intro", "")]
    parts += [s.get("paragraph", "") for s in post.get("sections", [])]
    parts += [f.get("answer", "") for f in post.get("faq", [])]
    parts.append(post.get("closing", ""))
    return len(" ".join(parts).split())


def contains_banned_phrase(post):
    haystack = " ".join([
        post.get("intro", ""),
        *[s.get("paragraph", "") for s in post.get("sections", [])],
        post.get("closing", ""),
    ]).lower()
    for phrase in BANNED_PHRASES:
        if phrase in haystack:
            return phrase
    return None


def generate_post(keyword_data, recent_titles):
    banned_list = ", ".join(f'"{p}"' for p in BANNED_PHRASES)
    avoid_titles = "\n".join(f"- {t}" for t in recent_titles[-25:]) or "(none yet)"

    system_prompt = (
        f"You write blog posts for {SITE_NAME}, an anonymous imageboard/forum "
        "(no accounts required, thread-based discussion). The blog covers "
        "anonymity, online privacy, internet culture, moderation, and how "
        "anonymous communities work.\n\n"
        "Write like a knowledgeable person explaining something to a smart "
        "friend, not like a content-mill article. Every post must satisfy "
        "three hard rules: (1) it must be 800-2,000+ words of substantive "
        "content, never padded to hit a count; (2) it must be original — "
        "your own explanation and analysis, not a paraphrase or summary of "
        "existing articles you've seen on this subject; (3) it must be "
        "genuinely helpful enough that a stranger arriving from a Google "
        "search would get real value and not feel like they wasted a "
        "click. Concretely:\n"
        "- Open by directly answering or engaging with the query in the "
        "first sentence — no throat-clearing, no restating the topic as a "
        "question, no scene-setting.\n"
        "- Use specific, concrete details, examples, and plausible "
        "scenarios instead of vague generalities. Prefer 'a moderator "
        "reviewing a flagged thread has to decide within seconds' over "
        "'moderation can be challenging.'\n"
        "- Every section should teach the reader something they could "
        "actually use or apply — a distinction they didn't have before, a "
        "concrete way to recognize or do something, a real tradeoff to "
        "weigh — not a restatement of the section heading in longer form.\n"
        "- Vary sentence length and structure. Short sentences are fine. "
        "Do not open every paragraph or section the same way.\n"
        "- Never use any of these words or phrases, in any form: "
        f"{banned_list}.\n"
        "- No markdown formatting inside any text field (no **, no #, no "
        "bullet lists) — plain prose only, it gets inserted into HTML "
        "paragraphs directly.\n"
        "- Do not invent statistics, studies, named individuals, or "
        "specific companies/products you can't verify. Stay general and "
        "factual about how things work rather than citing fake sources.\n"
        "- Output ONLY valid JSON, no markdown code fences, no commentary "
        "before or after."
    )

    user_prompt = f"""Write a full blog post targeting this exact search query: "{keyword_data['keyword']}"
Search intent: {keyword_data['intent']}
Required angle: {keyword_data['angle']}

Target length: {TARGET_WORD_COUNT} words total across intro + sections + faq + closing
(hard floor: {MIN_WORD_COUNT} words — never submit less; fine to go well over
{TARGET_WORD_COUNT} if the topic genuinely supports it, but never pad).

Do NOT reuse or closely rewrite any of these already-published titles:
{avoid_titles}

Return ONLY a JSON object with this exact shape:
{{
  "title": "string, <= 70 characters, should closely match what someone searching '{keyword_data['keyword']}' wants to click, no quotes inside",
  "meta_description": "string, <= 155 characters, plain text, written to earn the click from someone who searched that query",
  "intro": "2-3 sentences that directly satisfy the query immediately, not a warm-up",
  "sections": [
    {{"heading": "string, specific and non-generic, ideally phrased as something a reader would search or wonder", "paragraph": "6-9 sentences, concrete and specific, dense with actual information rather than restating the heading"}},
    ... 5 to 7 of these total, each covering a genuinely distinct sub-question or angle, ordered so the most important point comes first ...
  ],
  "faq": [
    {{"question": "a related question a reader would plausibly search next", "answer": "2-4 sentence direct answer"}},
    ... 3 to 5 of these ...
  ],
  "closing": "2-3 sentence closing paragraph, no restating of everything above. It's fine to naturally reference InteractInk once here if truly relevant, but do not be promotional or salesy."
}}"""

    # Generous headroom: posts can legitimately run past 2,000 words, plus
    # JSON structure (headings, FAQ, escaping) adds overhead on top of the
    # raw word count.
    raw = call_groq(system_prompt, user_prompt, max_tokens=5500)
    raw = strip_json_fences(raw)
    post = json.loads(raw)

    required = ["title", "meta_description", "intro", "sections", "faq", "closing"]
    for key in required:
        if key not in post or not post[key]:
            raise ValueError(f"Model response missing required field: {key}")
    if not isinstance(post["sections"], list) or len(post["sections"]) < 4:
        raise ValueError("Model response did not include enough sections")
    if not isinstance(post["faq"], list) or len(post["faq"]) < 2:
        raise ValueError("Model response did not include enough FAQ entries")

    wc = word_count(post)
    if wc < MIN_WORD_COUNT:
        raise ValueError(f"Post too short ({wc} words, need {MIN_WORD_COUNT}+) — retrying")

    banned_hit = contains_banned_phrase(post)
    if banned_hit:
        raise ValueError(f"Post used banned generic phrase '{banned_hit}' — retrying")

    post["keyword"] = keyword_data["keyword"]
    return post


# --------------------------------------------------------------------------
# HTML RENDERING — mirrors history-of-anonymous-boards.html exactly
# --------------------------------------------------------------------------

POST_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script>
    (function(){{
      try {{
        var p = localStorage.getItem('ink-theme-preference') || 'dark';
        var t = p;
        if (p === 'system') {{
          var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
          t = (mq && mq.matches) ? 'light' : 'dark';
        }}
        document.documentElement.setAttribute('data-theme', t);
      }} catch(e) {{}}
    }})();
    </script>
    <link rel="stylesheet" href="../theme.css">
    <link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
    <link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
    <link rel="preconnect" href="https://unpkg.com" crossorigin>
    <title>{title} - {site_name}</title>
    <meta name="description" content="{meta_description}">
    <link rel="canonical" href="{canonical_url}">
    <meta name="robots" content="index, follow">
    <meta name="google-adsense-account" content="{adsense_client}">
    <meta name="google-site-verification" content="{site_verification}" />

    <!-- Open Graph -->
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="{site_name}">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{meta_description}">
    <meta property="og:url" content="{canonical_url}">
    <meta property="og:image" content="{og_image_url}">

    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={adsense_client}" crossorigin="anonymous"></script>
    <script async src="https://www.googletagmanager.com/gtag/js?id={ga_id}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){{dataLayer.push(arguments);}}
      gtag('js', new Date());
      gtag('config', '{ga_id}');
    </script>

    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://unpkg.com/lucide@latest"></script>

    <script type="application/ld+json">{schema_json_ld}</script>

    <style>
        body {{ background-color: #000000; color: #e7e9ea; }}
        ::-webkit-scrollbar {{ width: 6px; }}
        ::-webkit-scrollbar-track {{ background: #000000; }}
        ::-webkit-scrollbar-thumb {{ background: #202327; border-radius: 9999px; }}
        .inline-link {{ color: #3b82f6; text-decoration: underline; font-weight: 500; transition: color 0.1s ease; }}
        .inline-link:hover {{ color: #60a5fa; }}
        .footer-link {{ color: #e7e9ea; text-decoration: none; margin: 0 14px; font-weight: 500; font-size: 0.85rem; transition: opacity 0.2s; display: inline-block; margin-bottom: 8px; }}
        .footer-link:hover {{ opacity: 0.7; }}
        .widget-link {{ color: #71767b; text-decoration: none; margin: 0 8px; font-weight: 500; font-size: 0.8rem; transition: color 0.2s; display: inline-block; margin-bottom: 6px; }}
        .widget-link:hover {{ color: #e7e9ea; }}
        .app-container {{
            display: grid;
            grid-template-columns: 1fr;
            min-height: 100vh;
            background-color: #000000;
        }}
        @media (min-width: 1024px) {{
            .app-container {{
                grid-template-columns: 1fr 275px 700px 300px 1fr;
                align-items: start;
            }}
        }}
        .x-sidebar {{ display: none; }}
        @media (min-width: 1024px) {{
            .x-sidebar {{
                display: flex;
                flex-direction: column;
                grid-column: 2;
                position: sticky;
                top: 0;
                align-self: start;
                height: 100vh;
                padding: 12px 12px 20px 12px;
                border-right: 1px solid #2f3336;
                overflow-y: auto;
                align-items: flex-start;
            }}
        }}
        .x-feed {{ grid-column: 1; min-height: 100vh; }}
        @media (min-width: 1024px) {{
            .x-feed {{ grid-column: 3; border-right: 1px solid #2f3336; }}
        }}
        .nav-item {{
            display: flex; align-items: center; gap: 20px;
            padding: 12px 20px 12px 12px; border-radius: 9999px;
            font-size: 1.25rem; font-weight: 500; color: #e7e9ea;
            text-decoration: none; transition: background-color 0.2s ease;
            width: fit-content;
        }}
        .nav-item:hover {{ background-color: #16181c; }}
        .nav-item.active {{ font-weight: 700; }}
        .nav-item svg {{ width: 26px; height: 26px; stroke-width: 2px; }}
        .x-widgets {{ display: none; }}
        @media (min-width: 1024px) {{
            .x-widgets {{
                display: flex; flex-direction: column; grid-column: 4;
                position: sticky; top: 0; align-self: start; height: 100vh;
                padding: 20px 24px; gap: 20px; overflow-y: auto;
            }}
        }}
        .bottom-tab-bar {{ display: none; }}
        .bottom-tab {{ display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: #71767b; text-decoration: none; padding: 6px 10px; }}
        .bottom-tab.active {{ color: #ffffff; }}
        .bottom-tab svg {{ width: 20px; height: 20px; }}
        @media (max-width: 1023px) {{
            .bottom-tab-bar {{
                display: flex; justify-content: space-around; align-items: center;
                position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
                background: rgba(0,0,0,0.97); backdrop-filter: blur(12px);
                border-top: 1px solid #262626; padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
            }}
            body {{ padding-bottom: 60px; }}
        }}
    </style>
    <link rel="stylesheet" href="../enhancements.css">
</head>
<body class="min-h-screen font-sans antialiased selection:bg-neutral-800 selection:text-white">
    <div class="app-container">
        <aside class="x-sidebar">
            <div class="py-2 px-3 mb-4">
                <a href="../index.html">
                    <img src="../favicon2.png" alt="{site_name} Logo" class="w-10 h-10 object-contain hover:opacity-90 transition">
                </a>
            </div>
            <nav class="flex flex-col gap-1 w-full mb-4">
                <a href="../index.html" class="nav-item">
                    <i data-lucide="home"></i>
                    <span>Home</span>
                </a>
                <a href="../interactink.html" class="nav-item">
                    <i data-lucide="message-square"></i>
                    <span>Board</span>
                </a>
                <a href="../ichat.html" class="nav-item">
                    <i data-lucide="message-circle-code"></i>
                    <span>iChat</span>
                </a>
                <a href="../about.html" class="nav-item">
                    <i data-lucide="info"></i>
                    <span>About</span>
                </a>
                <a href="../faq.html" class="nav-item">
                    <i data-lucide="help-circle"></i>
                    <span>FAQ</span>
                </a>
                <a href="../blog.html" class="nav-item active">
                    <i data-lucide="rss"></i>
                    <span>Blog</span>
                </a>
                <a href="../contact.html" class="nav-item">
                    <i data-lucide="mail"></i>
                    <span>Contact</span>
                </a>
                <a href="../settings.html" class="nav-item">
                    <i data-lucide="settings"></i>
                    <span>Settings</span>
                </a>
            </nav>
            <a href="../index.html" class="mt-2 w-11/12 bg-white text-black hover:bg-neutral-200 font-bold py-3.5 rounded-full text-center transition duration-200 text-[15px] shadow-sm">
                Post
            </a>
        </aside>
        <div class="x-feed">
    <div class="max-w-2xl mx-auto min-h-screen flex flex-col border-x border-neutral-800">
        <header class="sticky top-[49px] bg-black/90 backdrop-blur-md border-b border-neutral-800 p-4 z-40 flex items-center gap-2">
            <img src="../favicon2.png" alt="Logo" class="w-6 h-6">
            <h1 class="text-lg font-bold tracking-tight text-white">Blog</h1>
        </header>
        <main class="px-5 py-6 flex-1">

<div class="inline-block px-3 py-1 text-[10px] font-mono font-semibold text-neutral-400 bg-neutral-900 border border-neutral-800 rounded-full uppercase tracking-wider mb-6">Published {published_date}</div>
{hero_image_html}
<h2 class="text-white font-bold text-2xl mb-5 tracking-tight leading-tight">{title}</h2>
<p class="text-neutral-300 text-sm leading-relaxed mb-4">{intro}</p>{sections_html}
{faq_html}
<div class="mt-8 pt-4 border-t border-neutral-900">
    <a href="../blog.html" class="inline-link">&larr; Back to Blog</a>
</div>

        </main>
    </div>

    <footer style="width: 100%; text-align: center; padding: 40px 20px; margin-top: 24px; border-top: 1px solid #262626; color: #71767b;">
        <a href="../about.html" class="footer-link">About</a>
        <a href="../faq.html" class="footer-link">FAQ</a>
        <a href="../blog.html" class="footer-link">Blog</a>
        <a href="../contact.html" class="footer-link">Contact</a>
        <a href="../terms.html" class="footer-link">Terms</a>
        <a href="../guidelines.html" class="footer-link">Guidelines</a>
        <a href="../privacy.html" class="footer-link">Privacy Policy</a>
        <p style="margin-top: 20px; font-size: 0.85rem;">&copy; {year} {site_name}. All rights reserved.</p>
    </footer>
        </div>
    <aside class="x-widgets">
        <div class="bg-[#16181c] rounded-2xl p-4 border border-neutral-900">
            <h2 class="text-white font-bold text-base mb-3">About {site_name}</h2>
            <p class="text-neutral-400 text-xs leading-normal mb-3">
                A zero-friction, layout-focused environment to speak your mind freely.
            </p>
            <div class="flex flex-wrap pt-2">
                <a href="../about.html" class="widget-link">About</a>
                <a href="../faq.html" class="widget-link">FAQ</a>
                <a href="../blog.html" class="widget-link">Blog</a>
                <a href="../contact.html" class="widget-link">Contact</a>
                <a href="../terms.html" class="widget-link">Terms</a>
                <a href="../guidelines.html" class="widget-link">Rules</a>
                <a href="../privacy.html" class="widget-link">Privacy</a>
            </div>
            <p class="text-[11px] text-neutral-600 mt-3">&copy; {year} {site_name}</p>
        </div>
    </aside>
    <nav class="bottom-tab-bar" aria-label="Mobile navigation">
            <a href="../index.html" class="bottom-tab"><i data-lucide="home"></i></a>
            <a href="../interactink.html" class="bottom-tab"><i data-lucide="message-square"></i></a>
            <a href="../ichat.html" class="bottom-tab"><i data-lucide="message-circle-code"></i></a>
            <a href="../settings.html" class="bottom-tab active"><i data-lucide="settings"></i></a>
        </nav>
    </div>

    <script>
        if (window.lucide) lucide.createIcons();
    </script>
    <script src="../enhancements.js" defer></script>
    <script src="../theme.js" defer></script>
</body>
</html>
"""

INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script>
    (function(){{
      try {{
        var p = localStorage.getItem('ink-theme-preference') || 'dark';
        var t = p;
        if (p === 'system') {{
          var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
          t = (mq && mq.matches) ? 'light' : 'dark';
        }}
        document.documentElement.setAttribute('data-theme', t);
      }} catch(e) {{}}
    }})();
    </script>
    <link rel="stylesheet" href="../theme.css">
    <title>Blog Archive - {site_name}</title>
    <meta name="description" content="Full archive of every {site_name} blog post.">
    <link rel="canonical" href="{site_url}/blogs/index.html">
    <meta name="robots" content="index, follow">
    <link rel="icon" type="image/png" href="../favicon2.png">
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        body {{ background-color: #000000; color: #e7e9ea; }}
        .inline-link {{ color: #3b82f6; text-decoration: underline; font-weight: 500; }}
        .inline-link:hover {{ color: #60a5fa; }}
        .footer-link {{ color: #71767b; text-decoration: none; margin: 0 8px; font-weight: 500; font-size: 0.8rem; }}
        .footer-link:hover {{ color: #e7e9ea; }}
    </style>
    <link rel="stylesheet" href="../enhancements.css">
</head>
<body class="min-h-screen font-sans antialiased selection:bg-neutral-800 selection:text-white">
    <div class="max-w-2xl mx-auto min-h-screen flex flex-col border-x border-neutral-800">
        <header class="sticky top-0 bg-black/90 backdrop-blur-md border-b border-neutral-800 p-4 z-40 flex items-center gap-2">
            <img src="../favicon2.png" alt="Logo" class="w-6 h-6">
            <h1 class="text-lg font-bold tracking-tight text-white">Blog Archive</h1>
        </header>
        <main class="px-5 py-6 flex-1">
            <p class="text-neutral-300 text-sm leading-relaxed mb-4">Every post, newest first ({count} total). <a href="../blog.html" class="inline-link">Back to main blog</a>.</p>
            <div class="blog-list border border-neutral-800 rounded-xl overflow-hidden divide-y divide-neutral-800 mt-4">
{entries_html}
            </div>
        </main>
        <footer style="width: 100%; text-align: center; padding: 40px 20px; margin-top: 8px; border-top: 1px solid #262626; color: #71767b;">
            <a href="../about.html" class="footer-link">About</a>
            <a href="../blog.html" class="footer-link">Blog</a>
            <a href="../contact.html" class="footer-link">Contact</a>
            <p style="margin-top: 20px; font-size: 0.85rem;">&copy; {year} {site_name}. All rights reserved.</p>
        </footer>
    </div>
    <script>if (window.lucide) lucide.createIcons();</script>
    <script src="../enhancements.js" defer></script>
    <script src="../theme.js" defer></script>
</body>
</html>
"""


def render_sections_html(sections):
    parts = []
    for s in sections:
        heading = s["heading"].strip()
        paragraph = s["paragraph"].strip()
        parts.append(
            f'<h2 class="text-white font-bold text-lg mt-8 mb-3 tracking-tight first:mt-0">{heading}</h2>'
            f'<p class="text-neutral-300 text-sm leading-relaxed mb-4">{paragraph}</p>'
        )
    return "".join(parts)


def render_faq_html(faq):
    if not faq:
        return ""
    items = []
    for f in faq:
        q = f["question"].strip()
        a = f["answer"].strip()
        items.append(
            '<div class="mb-4">'
            f'<p class="text-white font-semibold text-sm mb-1">{q}</p>'
            f'<p class="text-neutral-300 text-sm leading-relaxed">{a}</p>'
            '</div>'
        )
    return (
        '<h2 class="text-white font-bold text-lg mt-8 mb-3 tracking-tight">Frequently Asked Questions</h2>'
        '<div>' + "".join(items) + '</div>'
    )


def render_hero_image_html(image):
    if not image:
        return ""
    return (
        '<figure class="mb-6">'
        f'<img src="{image["url"]}" alt="{image["alt"]}" loading="lazy" '
        'class="w-full rounded-xl border border-neutral-800 object-cover" '
        'style="max-height:420px;">'
        f'<figcaption class="text-neutral-600 text-[11px] mt-2">{image["attribution"]}</figcaption>'
        '</figure>'
    )


def render_schema_json_ld(post, slug, canonical_url, published_iso, image_url):
    schema = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "Article",
                "headline": post["title"],
                "description": post["meta_description"],
                "url": canonical_url,
                "datePublished": published_iso,
                "dateModified": published_iso,
                "image": image_url,
                "publisher": {"@type": "Organization", "name": SITE_NAME, "url": SITE_URL},
                "author": {"@type": "Organization", "name": SITE_NAME},
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {
                        "@type": "Question",
                        "name": f["question"],
                        "acceptedAnswer": {"@type": "Answer", "text": f["answer"]},
                    }
                    for f in post.get("faq", [])
                ],
            },
        ],
    }
    # separators without extra whitespace keep this compact inside <script>
    return json.dumps(schema, ensure_ascii=False, separators=(",", ":"))


def render_index_html(manifest):
    posts_sorted = sorted(manifest, key=lambda p: p["created_at"], reverse=True)
    entries = []
    for p in posts_sorted:
        entries.append(
            f'                <a href="{p["slug"]}.html" class="block p-4 hover:bg-neutral-950/50 transition border-b border-neutral-800 last:border-b-0">\n'
            f'                    <h3 class="text-white font-bold text-sm mb-1">{p["title"]}</h3>\n'
            f'                    <p class="text-neutral-500 text-xs leading-relaxed">{p["meta_description"]}</p>\n'
            f'                </a>'
        )
    return INDEX_TEMPLATE.format(
        site_name=SITE_NAME,
        site_url=SITE_URL,
        count=len(posts_sorted),
        entries_html="\n".join(entries),
        year=datetime.now().year,
    )


# --------------------------------------------------------------------------
# MANIFEST (tracks every generated post so we never repeat topics/slugs)
# --------------------------------------------------------------------------

def load_manifest(blogs_dir):
    path = os.path.join(blogs_dir, "manifest.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def save_manifest(blogs_dir, manifest):
    path = os.path.join(blogs_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)


SCROLLER_OPEN_MARKER = '<div id="blogScroller" class="blog-scroller" aria-label="Recent posts">'
LIST_OPEN_MARKER = '<div class="blog-list border border-neutral-800 rounded-xl overflow-hidden divide-y divide-neutral-800 mt-4">'
ARCHIVE_LINK_HTML = '<a href="blogs/index.html" class="inline-link text-xs">View the full auto-generated archive &rarr;</a>'


def update_blog_html_page(site_dir, slug, title, meta_description, short_date, total_count):
    """Prepend the new post to blog.html itself — both the horizontal
    'blog-scroller' strip (the same drag/swipe strip used for boards in
    interactink.html) and the full vertical list below it — and refresh
    the total-post counter. This runs on every single post, not just once,
    so blog.html always shows every post that's ever been published,
    newest first, without needing a separate archive click.

    Matches by exact marker strings already present in blog.html. If a
    marker isn't found (e.g. blog.html's structure changed), this logs a
    warning and skips that part rather than corrupting the file — the
    post itself is still published fine under blogs/<slug>.html either way.
    """
    blog_path = os.path.join(site_dir, "blog.html")
    if not os.path.exists(blog_path):
        log("blog.html not found — skipping in-page update.")
        return
    with open(blog_path, "r", encoding="utf-8") as f:
        html = f.read()

    chip = (
        f'<a href="blogs/{slug}.html" class="blog-scroller-chip" data-slug="{slug}">'
        f'<span class="blog-scroller-chip-title">{title}</span>'
        f'<span class="blog-scroller-chip-date">{short_date}</span></a>'
    )
    if SCROLLER_OPEN_MARKER in html:
        html = html.replace(SCROLLER_OPEN_MARKER, SCROLLER_OPEN_MARKER + chip, 1)
    else:
        log("Could not find the blog scroller in blog.html — skipping chip insert.")

    card = (
        f'<a href="blogs/{slug}.html" class="block p-4 hover:bg-neutral-950/50 transition border-b border-neutral-800 last:border-b-0">'
        f'<h3 class="text-white font-bold text-sm mb-1">{title}</h3>'
        f'<p class="text-neutral-500 text-xs leading-relaxed">{meta_description}</p>'
        f'</a>'
    )
    if LIST_OPEN_MARKER in html:
        html = html.replace(LIST_OPEN_MARKER, LIST_OPEN_MARKER + card, 1)
    else:
        log("Could not find the blog list in blog.html — skipping card insert.")

    html = ensure_and_update_counter(html, total_count)

    with open(blog_path, "w", encoding="utf-8") as f:
        f.write(html)


def ensure_and_update_counter(html, total_count):
    counter_span = f'<span id="blogPostCount">{total_count}</span>'
    if 'id="blogPostCount"' in html:
        return re.sub(r'<span id="blogPostCount">\d+</span>', counter_span, html)
    counter_line = f'\n                <p class="text-neutral-500 text-xs mt-2">{counter_span} posts published so far</p>'
    if ARCHIVE_LINK_HTML in html:
        return html.replace(ARCHIVE_LINK_HTML, ARCHIVE_LINK_HTML + counter_line, 1)
    log("Could not find a spot to attach the post counter in blog.html — skipping.")
    return html


def ensure_archive_link(site_dir):
    """Idempotently add a 'Full Archive' link into blog.html pointing at blogs/index.html."""
    blog_path = os.path.join(site_dir, "blog.html")
    if not os.path.exists(blog_path):
        return
    with open(blog_path, "r", encoding="utf-8") as f:
        content = f.read()
    if "blogs/index.html" in content:
        return  # already linked
    marker = '<p class="text-neutral-300 text-sm leading-relaxed mb-4">Notes on anonymity, privacy, and how InteractInk works.</p>'
    if marker in content:
        replacement = marker + (
            '\n                <a href="blogs/index.html" class="inline-link text-xs">'
            'View the full auto-generated archive &rarr;</a>'
        )
        content = content.replace(marker, replacement, 1)
        with open(blog_path, "w", encoding="utf-8") as f:
            f.write(content)
        log("Inserted 'Full Archive' link into blog.html")


# --------------------------------------------------------------------------
# MAIN CYCLE
# --------------------------------------------------------------------------

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def run_one_cycle(site_dir):
    blogs_dir = os.path.join(site_dir, "blogs")
    os.makedirs(blogs_dir, exist_ok=True)

    manifest = load_manifest(blogs_dir)
    existing_slugs = {p["slug"] for p in manifest}
    recent_titles = [p["title"] for p in manifest]
    recent_keywords = [p.get("keyword", p["title"]) for p in manifest]

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS_PER_CYCLE + 1):
        try:
            log(f"Planning target keyword (attempt {attempt}/{MAX_ATTEMPTS_PER_CYCLE})...")
            keyword_data = generate_target_keyword(recent_keywords)
            log(f"Target query: \"{keyword_data['keyword']}\" (intent: {keyword_data['intent']})")

            log("Writing post...")
            post = generate_post(keyword_data, recent_titles)

            log(f"Looking up a hero image for \"{keyword_data['image_query']}\"...")
            image = fetch_image_for_post(keyword_data["image_query"])

            base_slug = slugify(post["title"])
            slug = unique_slug(base_slug, existing_slugs)

            now = datetime.now(timezone.utc)
            published_human = now.strftime("%B %-d, %Y") if os.name != "nt" else now.strftime("%B %#d, %Y")
            short_date = now.strftime("%b %-d") if os.name != "nt" else now.strftime("%b %#d")
            canonical_url = f"{SITE_URL}/blogs/{slug}.html"
            og_image_url = image["url"] if image else f"{SITE_URL}/favicon2.png"

            sections_html = render_sections_html(post["sections"])
            sections_html += f'<p class="text-neutral-300 text-sm leading-relaxed mb-4">{post["closing"]}</p>'
            faq_html = render_faq_html(post.get("faq"))
            hero_image_html = render_hero_image_html(image)
            schema_json_ld = render_schema_json_ld(
                post, slug, canonical_url, now.isoformat(), og_image_url
            )

            html = POST_TEMPLATE.format(
                title=post["title"],
                meta_description=post["meta_description"],
                intro=post["intro"],
                sections_html=sections_html,
                faq_html=faq_html,
                hero_image_html=hero_image_html,
                og_image_url=og_image_url,
                schema_json_ld=schema_json_ld,
                published_date=published_human,
                canonical_url=canonical_url,
                site_name=SITE_NAME,
                site_url=SITE_URL,
                adsense_client=ADSENSE_CLIENT,
                site_verification=SITE_VERIFICATION,
                ga_id=GA_ID,
                year=now.year,
            )

            out_path = os.path.join(blogs_dir, f"{slug}.html")
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(html)

            manifest.append({
                "slug": slug,
                "title": post["title"],
                "meta_description": post["meta_description"],
                "keyword": post["keyword"],
                "created_at": now.isoformat(),
            })
            save_manifest(blogs_dir, manifest)

            index_html = render_index_html(manifest)
            with open(os.path.join(blogs_dir, "index.html"), "w", encoding="utf-8") as f:
                f.write(index_html)

            ensure_archive_link(site_dir)
            update_blog_html_page(
                site_dir, slug, post["title"], post["meta_description"],
                short_date, total_count=len(manifest),
            )

            log(f"Published: blogs/{slug}.html  —  \"{post['title']}\"  ({word_count(post)} words)")
            log(f"blog.html and blogs/index.html both updated. Total posts: {len(manifest)}")
            return True

        except Exception as e:
            last_error = e
            log(f"Attempt {attempt} failed: {e}")
            if attempt < MAX_ATTEMPTS_PER_CYCLE:
                time.sleep(RETRY_BACKOFF_SECONDS)

    log(f"Giving up on this cycle after {MAX_ATTEMPTS_PER_CYCLE} attempts. Last error: {last_error}")
    traceback.print_exc()
    return False


def main():
    parser = argparse.ArgumentParser(description="InteractInk automatic blog generator")
    parser.add_argument("--site-dir", default=None, help="Path to your InteractInk site folder (default: this script's folder)")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL_SECONDS, help=f"Seconds between posts (default {DEFAULT_INTERVAL_SECONDS} = {DEFAULT_INTERVAL_SECONDS // 3600} hours)")
    parser.add_argument("--once", action="store_true", help="Generate a single post and exit (useful for testing)")
    args = parser.parse_args()

    site_dir = resolve_site_dir(args.site_dir)
    log(f"Site directory: {site_dir}")
    log(f"Blog posts will be saved in: {os.path.join(site_dir, 'blogs')}")

    if args.once:
        run_one_cycle(site_dir)
        return

    log(f"Starting forever loop — new post every {args.interval} seconds. Press Ctrl+C to stop.")
    while True:
        run_one_cycle(site_dir)
        log(f"Sleeping {args.interval} seconds until next post...")
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            log("Stopped by user.")
            break


if __name__ == "__main__":
    main()