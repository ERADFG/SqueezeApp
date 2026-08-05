#!/usr/bin/env python3
"""
Regenerates sitemap.xml (every indexable page on the site) and
sitemap-pages.xml (the same static-page subset, kept as a separate feed for
robots.txt) so every real, public page is always represented and nothing
that shouldn't be public (admin/moderation panels, orphaned duplicate
pages, verification files) ever leaks in.

Page sources, all verified to exist on disk before being written out:
  - STATIC_PAGES below (hand-maintained, evergreen pages)
  - build_blog_v2.py's ARTICLES array (the 5 featured root-level articles)
  - blogs/manifest.json (every archived article under /blogs/)

Deliberately excluded (not content pages / not meant to be indexed):
  404.html, admin.html, admin-review.html, manage-*.html (moderation),
  interactink2.html (orphaned duplicate of interactink.html),
  *verification*.html/.xml/.txt files.

Run this any time you add/remove an article:
    python3 generate_sitemap.py
"""
import json
import re
import datetime

DOMAIN = "https://interactink.vercel.app"
TODAY = datetime.date.today().isoformat()

# Static, hand-maintained pages. changefreq/priority reflect real update cadence.
STATIC_PAGES = [
    ("/",                 "daily",   "1.0"),
    ("/interactink.html", "hourly",  "1.0"),
    ("/index.html",       "monthly", "0.5"),
    ("/ichat.html",       "weekly",  "0.8"),
    ("/about.html",       "monthly", "0.6"),
    ("/faq.html",         "monthly", "0.6"),
    ("/contact.html",     "yearly",  "0.3"),
    ("/terms.html",       "yearly",  "0.3"),
    ("/guidelines.html",  "monthly", "0.4"),
    ("/privacy.html",     "yearly",  "0.3"),
    ("/settings.html",    "monthly", "0.3"),
    ("/blog.html",        "weekly",  "0.7"),
    ("/blogs/",           "weekly",  "0.6"),
]

def extract_article_filenames(script_path="build_blog_v2.py"):
    with open(script_path, "r", encoding="utf-8") as f:
        src = f.read()
    # Pulls filenames straight from ARTICLES.append(("filename.html", ...)
    return re.findall(r'ARTICLES\.append\(\("([^"]+)"', src)

def extract_archive_slugs(manifest_path="blogs/manifest.json"):
    with open(manifest_path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    return [entry["slug"] for entry in data]

def build_urls():
    urls = []
    for path, freq, pri in STATIC_PAGES:
        urls.append((f"{DOMAIN}{path}", TODAY, freq, pri))

    for fname in extract_article_filenames():
        urls.append((f"{DOMAIN}/{fname}", TODAY, "monthly", "0.6"))

    for slug in extract_archive_slugs():
        urls.append((f"{DOMAIN}/blogs/{slug}.html", TODAY, "monthly", "0.5"))

    return urls

def render_xml(urls):
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
    all_urls = build_urls()
    with open("sitemap.xml", "w", encoding="utf-8") as f:
        f.write(render_xml(all_urls))
    print(f"Wrote sitemap.xml with {len(all_urls)} URLs "
          f"({len(STATIC_PAGES)} static + {len(extract_article_filenames())} featured "
          f"+ {len(extract_archive_slugs())} archive).")

    static_urls = [(f"{DOMAIN}{path}", TODAY, freq, pri) for path, freq, pri in STATIC_PAGES]
    with open("sitemap-pages.xml", "w", encoding="utf-8") as f:
        f.write(render_xml(static_urls))
    print(f"Wrote sitemap-pages.xml with {len(static_urls)} URLs (static pages only).")
