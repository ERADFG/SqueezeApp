#!/usr/bin/env python3
"""
InteractInk — Automatic Blog Generator
========================================
Runs forever. Every INTERVAL_SECONDS (default 1 minute) it:

  1. Asks Groq (free tier, no credit card, no region restriction) for a
     brand-new blog post (title + sections) on a topic
     related to anonymity / privacy / imageboards / internet culture that
     hasn't been covered yet.
  2. Renders it into an HTML page using the EXACT same UI shell as the rest
     of the site (sidebar nav, right widgets, mobile tab bar, footer, theme
     support, ads/analytics tags) — pulled straight from your existing
     article template (history-of-anonymous-boards.html).
  3. Saves it into a `blogs/` folder (so your site root doesn't get
     cluttered) as blogs/<slug>.html.
  4. Regenerates blogs/index.html — a master list of every generated post,
     newest first, styled like your existing blog.html.
  5. Updates blog.html directly and automatically: a horizontally-sliding
     "Recent Posts" strip right under the header (same drag/swipe/wheel
     sliding mechanism as the board switcher in interactink.html), plus the
     full vertical post list below it — both regenerated every cycle so
     every new post shows up on blog.html itself, no manual step needed.

USAGE
-----
    export GROQ_API_KEY="your-key-here"       # get a free key: https://console.groq.com/keys
    python3 auto_blog.py                      # run forever, every 1 minute
    python3 auto_blog.py --once               # generate a single post and exit (good for testing)
    python3 auto_blog.py --interval 300       # every 5 minutes instead
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
import urllib.request
from datetime import datetime, timezone

# --------------------------------------------------------------------------
# CONFIG
# --------------------------------------------------------------------------

MODEL = "llama-3.3-70b-versatile"
API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_INTERVAL_SECONDS = 60  # 1 minute
MAX_ATTEMPTS_PER_CYCLE = 3
RETRY_BACKOFF_SECONDS = 30

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

# --------------------------------------------------------------------------
# PATHS
# --------------------------------------------------------------------------

def resolve_site_dir(cli_value: str) -> str:
    if cli_value:
        return os.path.abspath(cli_value)
    # default: the folder this script lives in
    return os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------
# GROQ API CALL — genuinely free tier, no credit card, no region restriction
# --------------------------------------------------------------------------

def call_groq(system_prompt: str, user_prompt: str, max_tokens: int = 2200) -> str:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GROQ_API_KEY environment variable is not set. "
            "Get a free key (no credit card needed) from https://console.groq.com/keys and run:\n"
            "  PowerShell:  $env:GROQ_API_KEY=\"your-key-here\"\n"
            "  bash/macOS:  export GROQ_API_KEY=\"your-key-here\""
        )

    body = json.dumps({
        "model": MODEL,
        "max_tokens": max_tokens,
        "temperature": 0.9,
        "response_format": {"type": "json_object"},
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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InteractInk-AutoBlog/1.0",
            "Accept": "application/json",
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
# POST GENERATION
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


def strip_json_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"```$", "", text.strip())
    return text.strip()


def generate_post(recent_titles):
    topic_hint = random.choice(TOPIC_POOL)
    avoid_list = "\n".join(f"- {t}" for t in recent_titles[-25:]) or "(none yet)"

    system_prompt = (
        f"You write blog posts for {SITE_NAME}, an anonymous imageboard/forum "
        "(no accounts required, thread-based discussion). The blog covers "
        "anonymity, online privacy, internet culture, moderation, and how "
        "anonymous communities work. Tone: clear, direct, informative, "
        "grounded — never hypey or clickbaity, no emojis. Write for a general "
        "internet-literate reader. Output ONLY valid JSON, no markdown code "
        "fences, no commentary before or after."
    )

    user_prompt = f"""Write a new blog post. Suggested topic angle (you can adapt it): "{topic_hint}"

Do NOT reuse or closely rewrite any of these already-published titles:
{avoid_list}

Return ONLY a JSON object with this exact shape:
{{
  "title": "string, <= 70 characters, no quotes inside",
  "meta_description": "string, <= 155 characters, plain text summary for SEO",
  "intro": "1 short paragraph (2-3 sentences) opening the post",
  "sections": [
    {{"heading": "string", "paragraph": "3-5 sentence paragraph"}},
    ... 4 to 6 of these total ...
  ],
  "closing": "1-2 sentence closing paragraph. It's fine to naturally reference InteractInk once here, but do not be promotional or salesy."
}}

Rules:
- No markdown formatting inside any text field (no **, no #, no bullet lists) — plain prose only, since it gets inserted directly into HTML paragraphs.
- Do not invent statistics, studies, or named sources.
- Keep it factual and general, not platform-specific claims you can't verify.
"""

    raw = call_groq(system_prompt, user_prompt)
    raw = strip_json_fences(raw)
    post = json.loads(raw)

    required = ["title", "meta_description", "intro", "sections", "closing"]
    for key in required:
        if key not in post or not post[key]:
            raise ValueError(f"Model response missing required field: {key}")
    if not isinstance(post["sections"], list) or len(post["sections"]) < 3:
        raise ValueError("Model response did not include enough sections")

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
    <meta property="og:image" content="{site_url}/favicon2.png">

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
<h2 class="text-white font-bold text-2xl mb-5 tracking-tight leading-tight">{title}</h2>
<p class="text-neutral-300 text-sm leading-relaxed mb-4">{intro}</p>{sections_html}
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


def render_post_html(post, slug, published_date_human):
    return POST_TEMPLATE.format(
        title=post["title"],
        meta_description=post["meta_description"],
        intro=post["intro"],
        sections_html=render_sections_html(post["sections"]),
        published_date=published_date_human,
        canonical_url=f"{SITE_URL}/blogs/{slug}.html",
        site_name=SITE_NAME,
        site_url=SITE_URL,
        adsense_client=ADSENSE_CLIENT,
        site_verification=SITE_VERIFICATION,
        ga_id=GA_ID,
        year=datetime.now().year,
    )
    # note: closing paragraph is appended by caller before this call normally;
    # kept simple here since sections_html already covers the body.


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


# --------------------------------------------------------------------------
# BLOG.HTML SYNC — injects a horizontally-sliding "Recent Posts" strip
# (same drag/swipe/wheel mechanism as the board switcher in interactink.html)
# plus an always-up-to-date vertical post list, directly into blog.html.
# --------------------------------------------------------------------------

BLOG_SCROLLER_CSS = """
        /* ==================================================================
           BLOG POST SCROLLER — mirrors the board-scroller drag/swipe strip
           used in interactink.html, adapted for blog posts.
        ================================================================== */
        .blog-scroller-wrap {
            position: relative;
            border-bottom: 1px solid #2f3336;
            background: rgba(0, 0, 0, 0.6);
        }
        .blog-scroller {
            display: flex;
            align-items: stretch;
            gap: 8px;
            overflow-x: auto;
            overflow-y: hidden;
            scroll-behavior: smooth;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
            padding: 10px 14px;
            cursor: grab;
            touch-action: pan-x;
        }
        .blog-scroller:active { cursor: grabbing; }
        .blog-scroller::-webkit-scrollbar { display: none; }
        .blog-scroller-chip {
            display: flex;
            flex-direction: column;
            justify-content: center;
            gap: 2px;
            flex-shrink: 0;
            scroll-snap-align: start;
            width: 190px;
            padding: 9px 13px;
            border-radius: 12px;
            color: #a1a1aa;
            background: #16181c;
            border: 1px solid #2f3336;
            text-decoration: none;
            user-select: none;
            transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
        }
        .blog-scroller-chip:hover { border-color: #525252; color: #e7e9ea; }
        .blog-scroller-chip-title {
            font-size: 12.5px;
            font-weight: 700;
            color: #e7e9ea;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }
        .blog-scroller-chip-date {
            font-family: ui-monospace, Menlo, monospace;
            font-size: 10px;
            color: #71767b;
        }
        .blog-scroller-edge {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 28px;
            pointer-events: none;
            z-index: 1;
        }
        .blog-scroller-edge.left { left: 0; background: linear-gradient(to right, #000000, transparent); }
        .blog-scroller-edge.right { right: 0; background: linear-gradient(to left, #000000, transparent); }
"""

BLOG_SCROLLER_JS = """
    <script>
    /* Desktop mouse-drag-to-scroll + vertical-wheel-to-horizontal-scroll for
       the blog post strip — same mechanism as the board-scroller in
       interactink.html. Touch devices get native swipe for free. */
    (function setupBlogScrollerDrag() {
        const scroller = document.getElementById('blogScroller');
        if (!scroller) return;
        let isDown = false, startX = 0, startScroll = 0, moved = false;
        scroller.addEventListener('mousedown', (e) => {
            isDown = true; moved = false;
            scroller.dataset.dragged = 'false';
            startX = e.pageX;
            startScroll = scroller.scrollLeft;
        });
        window.addEventListener('mouseup', () => {
            isDown = false;
            if (moved) setTimeout(() => { scroller.dataset.dragged = 'false'; }, 0);
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            const dx = e.pageX - startX;
            if (Math.abs(dx) > 4) { moved = true; scroller.dataset.dragged = 'true'; }
            scroller.scrollLeft = startScroll - dx;
        });
        scroller.addEventListener('click', (e) => {
            if (scroller.dataset.dragged === 'true') e.preventDefault();
        }, true);
        scroller.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                scroller.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
    })();
    </script>
"""

BLOG_HEADER_ANCHOR = (
    '            <!-- Blog header -->\n'
    '            <header class="blog-header p-4 flex items-center gap-2">\n'
    '                <img src="favicon2.png" alt="InteractInk logo" width="24" height="24" class="w-6 h-6">\n'
    '                <h1 class="text-lg font-bold tracking-tight text-white">Blog</h1>\n'
    '            </header>\n'
)


def render_scroller_chips(manifest):
    posts_sorted = sorted(manifest, key=lambda p: p["created_at"], reverse=True)
    chips = []
    for p in posts_sorted:
        created = datetime.fromisoformat(p["created_at"])
        date_short = created.strftime("%b %-d") if os.name != "nt" else created.strftime("%b %#d")
        chips.append(
            f'<a href="blogs/{p["slug"]}.html" class="blog-scroller-chip" data-slug="{p["slug"]}">'
            f'<span class="blog-scroller-chip-title">{p["title"]}</span>'
            f'<span class="blog-scroller-chip-date">{date_short}</span></a>'
        )
    return "".join(chips)


def render_main_list_entries(manifest):
    posts_sorted = sorted(manifest, key=lambda p: p["created_at"], reverse=True)
    entries = []
    for p in posts_sorted:
        entries.append(
            f'                    <a href="blogs/{p["slug"]}.html" class="block p-4 hover:bg-neutral-950/50 transition border-b border-neutral-800 last:border-b-0">\n'
            f'                        <h3 class="text-white font-bold text-sm mb-1">{p["title"]}</h3>\n'
            f'                        <p class="text-neutral-500 text-xs leading-relaxed">{p["meta_description"]}</p>\n'
            f'                    </a>'
        )
    return "\n".join(entries)


def sync_main_blog_page(site_dir, manifest):
    """Keeps blog.html itself in sync with every generated post: injects (once)
    a sliding 'Recent Posts' strip using the same drag/swipe/wheel mechanism
    as interactink.html's board scroller, and regenerates both the strip's
    contents and the full vertical post list on every cycle."""
    blog_path = os.path.join(site_dir, "blog.html")
    if not os.path.exists(blog_path):
        log("blog.html not found — skipping sync")
        return
    with open(blog_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1) Inject the scroller CSS once, right before the page's </style> tag.
    if "BLOG POST SCROLLER" not in content:
        content = content.replace("    </style>", BLOG_SCROLLER_CSS + "    </style>", 1)

    # 2) Inject the scroller markup once, right after the blog header.
    if 'id="blogScroller"' not in content and BLOG_HEADER_ANCHOR in content:
        scroller_block = (
            BLOG_HEADER_ANCHOR +
            '\n            <div class="blog-scroller-wrap">\n'
            '                <div id="blogScroller" class="blog-scroller" aria-label="Recent posts"><!-- BLOG_SCROLLER_CHIPS --></div>\n'
            '                <div class="blog-scroller-edge left" aria-hidden="true"></div>\n'
            '                <div class="blog-scroller-edge right" aria-hidden="true"></div>\n'
            '            </div>\n'
        )
        content = content.replace(BLOG_HEADER_ANCHOR, scroller_block, 1)

    # 3) Inject the drag-scroll JS once, right before </body>.
    if "setupBlogScrollerDrag" not in content:
        content = content.replace("</body>", BLOG_SCROLLER_JS + "</body>", 1)

    # 4) Regenerate the scroller's chip contents every cycle.
    content = re.sub(
        r'(<div id="blogScroller" class="blog-scroller" aria-label="Recent posts">).*?(</div>)',
        lambda m: m.group(1) + render_scroller_chips(manifest) + m.group(2),
        content,
        count=1,
        flags=re.DOTALL,
    )

    # 5) Regenerate the vertical post list every cycle so every post shows here too.
    content = re.sub(
        r'(<div class="blog-list[^"]*"[^>]*>).*?(</div>)',
        lambda m: m.group(1) + "\n" + render_main_list_entries(manifest) + "\n                " + m.group(2),
        content,
        count=1,
        flags=re.DOTALL,
    )

    with open(blog_path, "w", encoding="utf-8") as f:
        f.write(content)


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

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS_PER_CYCLE + 1):
        try:
            log(f"Generating new post (attempt {attempt}/{MAX_ATTEMPTS_PER_CYCLE})...")
            post = generate_post(recent_titles)

            base_slug = slugify(post["title"])
            slug = unique_slug(base_slug, existing_slugs)

            # fold the closing paragraph in as a final section-less paragraph
            now = datetime.now(timezone.utc)
            published_human = now.strftime("%B %-d, %Y") if os.name != "nt" else now.strftime("%B %#d, %Y")

            sections_html = render_sections_html(post["sections"])
            sections_html += f'<p class="text-neutral-300 text-sm leading-relaxed mb-4">{post["closing"]}</p>'

            html = POST_TEMPLATE.format(
                title=post["title"],
                meta_description=post["meta_description"],
                intro=post["intro"],
                sections_html=sections_html,
                published_date=published_human,
                canonical_url=f"{SITE_URL}/blogs/{slug}.html",
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
                "created_at": now.isoformat(),
            })
            save_manifest(blogs_dir, manifest)

            index_html = render_index_html(manifest)
            with open(os.path.join(blogs_dir, "index.html"), "w", encoding="utf-8") as f:
                f.write(index_html)

            sync_main_blog_page(site_dir, manifest)

            log(f"Published: blogs/{slug}.html  —  \"{post['title']}\"")
            log(f"Archive now has {len(manifest)} post(s): blogs/index.html")
            log("blog.html updated (sliding strip + full list)")
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
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL_SECONDS, help="Seconds between posts (default 600 = 10 minutes)")
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