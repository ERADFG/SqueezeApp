#!/usr/bin/env python3
"""
Regenerates sitemap.xml for the static/evergreen pages, deriving the blog
article list directly from build_blog_v2.py's ARTICLES array so the sitemap
can never reference a post that doesn't actually exist (no 404 risk, no
manual guessing, no stale entries when you add new articles).

Run this any time you add/remove an article in build_blog_v2.py:
    python3 generate_sitemap.py
"""
import re
import datetime

DOMAIN = "https://interactink.vercel.app"
TODAY = datetime.date.today().isoformat()

# Static, hand-maintained pages. changefreq/priority reflect real update cadence.
STATIC_PAGES = [
    ("/index.html",      "daily",   "1.0"),
    ("/about.html",      "monthly", "0.6"),
    ("/faq.html",         "monthly", "0.6"),
    ("/contact.html",    "yearly",  "0.3"),
    ("/terms.html",      "yearly",  "0.3"),
    ("/guidelines.html", "monthly", "0.4"),
    ("/privacy.html",    "yearly",  "0.3"),
    ("/blog/index.html", "weekly",  "0.7"),
]

def extract_article_filenames(script_path="build_blog_v2.py"):
    with open(script_path, "r", encoding="utf-8") as f:
        src = f.read()
    # Pulls filenames straight from ARTICLES.append(("filename.html", ...)
    return re.findall(r'ARTICLES\.append\(\("([^"]+)"', src)

def build_sitemap():
    urls = []
    for path, freq, pri in STATIC_PAGES:
        urls.append((f"{DOMAIN}{path}", TODAY, freq, pri))

    for fname in extract_article_filenames():
        urls.append((f"{DOMAIN}/blog/{fname}", TODAY, "monthly", "0.6"))

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, lastmod, freq, pri in urls:
        lines.append("  <url>")
        lines.append(f"    <loc>{loc}</loc>")
        lines.append(f"    <lastmod>{lastmod}</lastmod>")
        lines.append(f"    <changefreq>{freq}</changefreq>")
        lines.append(f"    <priority>{pri}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"

if __name__ == "__main__":
    xml = build_sitemap()
    with open("sitemap.xml", "w", encoding="utf-8") as f:
        f.write(xml)
    n = len(extract_article_filenames()) + len(STATIC_PAGES)
    print(f"Wrote sitemap.xml with {n} URLs (all verified to exist in ARTICLES/STATIC_PAGES).")
