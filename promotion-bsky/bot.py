#!/usr/bin/env python3
"""
Bluesky Auto-Reply Bot
-----------------------
Watches your Bluesky notifications for replies/comments on your posts
and automatically replies with a rotating template message.

Setup:
  1. pip install -r requirements.txt
  2. Copy .env.example to .env and fill in your handle + app password
  3. Edit TEMPLATES below (or in templates.json) to your liking
  4. Run once (good for cron):      python bot.py
     Run continuously (polling):    python bot.py --loop --interval 60

State (which comments you've already replied to) is stored in
replied_uris.json next to this script, so it's safe to run via cron
every few minutes without double-replying.
"""

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path

from atproto import Client, client_utils, models
from atproto_client.request import Request
from dotenv import load_dotenv

load_dotenv()

SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = SCRIPT_DIR / "replied_uris.json"
TEMPLATES_FILE = SCRIPT_DIR / "templates.json"

HANDLE = os.environ.get("BSKY_HANDLE")
APP_PASSWORD = os.environ.get("BSKY_APP_PASSWORD")

# Minimum seconds to wait between individual replies, to stay well clear of
# any spam-like posting cadence.
MIN_DELAY_BETWEEN_REPLIES = 63


URL_PATTERN = re.compile(
    r"(https?://[^\s]+|(?<![\w.])[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:/[^\s]*)?)",
    re.IGNORECASE,
)


def build_rich_text(template):
    """
    Turn a template string into a Bluesky rich-text post, converting any
    URL-looking substring into an actual clickable link facet. Bluesky does
    NOT auto-linkify plain text -- without this, a URL is just inert text.
    """
    match = URL_PATTERN.search(template)
    builder = client_utils.TextBuilder()

    if not match:
        builder.text(template)
        return builder

    before, url, after = template[:match.start()], match.group(0), template[match.end():]

    href = url if url.startswith("http") else f"https://{url}"

    if before:
        builder.text(before)
    builder.link(url, href)
    if after:
        builder.text(after)

    return builder


def load_templates():
    if TEMPLATES_FILE.exists():
        with open(TEMPLATES_FILE, "r", encoding="utf-8-sig") as f:
            templates = json.load(f)
        if isinstance(templates, list) and templates:
            return templates
    # Fallback defaults if templates.json is missing/empty
    return [
    "Got more to say? Drop it here: https://interactink.vercel.app",
    "Come share your take: https://interactink.vercel.app",
    "Add your voice to the thread: https://interactink.vercel.app",
    "Post your thoughts over here: https://interactink.vercel.app",
    "Join the conversation and post yours: https://interactink.vercel.app",
]  # NOTE: items must be comma-separated or Python silently merges them into one string


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return set(json.load(f))
    return set()


def save_state(seen_uris):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(sorted(seen_uris), f, indent=2)


def login():
    if not HANDLE or not APP_PASSWORD:
        print(
            "ERROR: Set BSKY_HANDLE and BSKY_APP_PASSWORD (in a .env file or "
            "as environment variables). Use an app password, not your main "
            "account password: https://bsky.app/settings/app-passwords",
            file=sys.stderr,
        )
        sys.exit(1)
    client = Client(request=Request(trust_env=False))  # bypass any system/leftover proxy settings
    client.login(HANDLE, APP_PASSWORD)
    return client


def is_reply_to_my_post(notif, my_did):
    """True if this notification is a reply (comment) on something I posted."""
    if notif.reason != "reply":
        return False
    record = notif.record
    reply_ref = getattr(record, "reply", None)
    if reply_ref is None:
        return False
    parent_uri = reply_ref.parent.uri
    # A post URI looks like at://<did>/app.bsky.feed.post/<rkey>
    parent_author_did = parent_uri.split("/")[2] if parent_uri.startswith("at://") else None
    return parent_author_did == my_did


def run_once(client, templates, seen_uris, verbose=True):
    profile = client.me
    my_did = profile.did

    resp = client.app.bsky.notification.list_notifications(
        params=models.AppBskyNotificationListNotifications.Params(limit=50)
    )
    notifications = resp.notifications

    new_replies = 0

    for notif in notifications:
        if notif.uri in seen_uris:
            continue

        if not is_reply_to_my_post(notif, my_did):
            continue

        # Don't reply to yourself
        if notif.author.did == my_did:
            seen_uris.add(notif.uri)
            continue

        comment_record = notif.record
        reply_ref = comment_record.reply  # has .root and .parent (StrongRef-like)

        parent_ref = models.ComAtprotoRepoStrongRef.Main(
            uri=notif.uri, cid=notif.cid
        )
        root_ref = models.ComAtprotoRepoStrongRef.Main(
            uri=reply_ref.root.uri, cid=reply_ref.root.cid
        )

        message = random.choice(templates)
        rich_text = build_rich_text(message)

        try:
            client.send_post(
                text=rich_text,
                reply_to=models.AppBskyFeedPost.ReplyRef(
                    parent=parent_ref,
                    root=root_ref,
                ),
            )
            if verbose:
                print(f"Replied to @{notif.author.handle} ({notif.uri}) -> \"{message}\"")
            new_replies += 1
        except Exception as e:
            print(f"Failed to reply to {notif.uri}: {e}", file=sys.stderr)
            continue  # don't mark as seen; retry next run

        seen_uris.add(notif.uri)
        save_state(seen_uris)  # persist incrementally in case of crash mid-run
        time.sleep(MIN_DELAY_BETWEEN_REPLIES)

    # Mark everything we looked at as seen, even non-matching notifications,
    # so future runs don't re-scan the same old items forever.
    for notif in notifications:
        seen_uris.add(notif.uri)
    save_state(seen_uris)

    # Mark notifications as read on Bluesky itself
    try:
        client.app.bsky.notification.update_seen({"seenAt": client.get_current_time_iso()})
    except Exception:
        pass

    if verbose:
        print(f"Done. {new_replies} new repl{'y' if new_replies == 1 else 'ies'} sent.")

    return new_replies


def main():
    parser = argparse.ArgumentParser(description="Bluesky auto-reply bot")
    parser.add_argument("--loop", action="store_true", help="Run continuously instead of once")
    parser.add_argument("--interval", type=int, default=60, help="Seconds between polls in --loop mode")
    args = parser.parse_args()

    templates = load_templates()
    seen_uris = load_state()
    client = login()

    print(f"Logged in as @{client.me.handle}. Loaded {len(templates)} reply template(s).")

    if args.loop:
        print(f"Polling every {args.interval}s. Press Ctrl+C to stop.")
        while True:
            try:
                run_once(client, templates, seen_uris)
            except KeyboardInterrupt:
                print("Stopped.")
                break
            except Exception as e:
                print(f"Error during poll: {e}", file=sys.stderr)
            time.sleep(args.interval)
    else:
        run_once(client, templates, seen_uris)


if __name__ == "__main__":
    main()