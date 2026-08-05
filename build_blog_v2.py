#!/usr/bin/env python3
"""
Article registry for the InteractInk blog.

NOTE (2026-08-05): this file was found containing only ads.txt's contents
(58 bytes, byte-identical to /ads.txt) instead of real code - almost
certainly an accidental overwrite/bad save at some point. Whatever this
script originally did to generate the article HTML is unrecoverable from
this repo; the 5 article pages themselves are fine and still live at the
site root (they were never lost, only this generator/registry was).

This reconstruction restores just enough for generate_sitemap.py to work:
the ARTICLES list it parses via regex to build sitemap.xml. If you have
a real templating step you used to originally produce these HTML files,
restore that instead and keep the ARTICLES.append(...) calls in it so
generate_sitemap.py keeps finding them.
"""

ARTICLES = []
ARTICLES.append(("how-anonymous-posting-works.html", "How Anonymous Posting Actually Works",
                  "What anonymity on a text board really protects you from, and what it doesn't."))
ARTICLES.append(("tripcodes-explained.html", "Tripcodes Explained",
                  "How InteractInk's tripcode system works, and what it doesn't do."))
ARTICLES.append(("online-privacy-basics.html", "Online Privacy Basics for Anonymous Communities",
                  "Practical privacy habits for anyone using anonymous platforms."))
ARTICLES.append(("history-of-anonymous-boards.html", "A Short History of Anonymous Message Boards",
                  "From BBS systems to imageboards: where the anonymous board format came from."))
ARTICLES.append(("how-to-use-interactink-safely.html", "How to Use InteractInk Safely",
                  "A practical guide to posting, replying, and reporting on the board."))

if __name__ == "__main__":
    for fname, title, desc in ARTICLES:
        print(fname)
