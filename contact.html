import sys
sys.path.insert(0, "/home/claude/interactink3")
from generate import build_page, h2, p, ul, code, link, meta_badge, svg_banner, human_note, faq_block

ROOT = "../"

def article_wrap(title, banner_kind, intro_note, body_sections, faqs):
    body = "".join(body_sections)
    faq_html = faq_block(faqs)
    return f"""
{meta_badge("Published [Date]")}
{svg_banner(banner_kind)}
<h2 class="text-white font-bold text-2xl mb-5 tracking-tight leading-tight">{title}</h2>
{human_note(intro_note)}
{body}
{faq_html}
<div class="mt-8 pt-4 border-t border-neutral-900">
    {link(ROOT + "blog/index.html", "&larr; Back to Blog")}
</div>
"""

ARTICLES = []  # (filename, title, description, banner_kind, content_html)

# ============================================================= 1
content = article_wrap(
    "How Anonymous Posting Actually Works", "network",
    "When I first set up InteractInk, the question I got most from testers wasn't &quot;is this safe?&quot; &mdash; it was &quot;what does anonymous actually mean here?&quot; That question is worth answering honestly rather than with a marketing line.",
    [
        p("&quot;Anonymous&quot; gets used loosely online, and it's worth being precise about what it actually means on a board like InteractInk, because the honest answer is more nuanced than &quot;nobody knows who you are.&quot;"),
        h2("No account, but not invisible"),
        p("When you post without an account, the site isn't asking you to prove who you are before you speak. That's the core feature: no email, no password, no profile tied to your words. But the site still has to run on a server somewhere, and servers log basic technical data &mdash; typically an IP address and a timestamp &mdash; as a matter of how the internet works, not as a deliberate tracking feature."),
        p("That distinction matters. Anonymous posting protects you from other users and from casual observers. It doesn't make you invisible to the platform operator, and it doesn't protect you from a legal process that compels a site to hand over logs. Any board that claims otherwise is overselling what's technically possible."),
        h2("Why boards remove usernames instead of hiding IPs"),
        p("The privacy benefit of an anonymous board isn't really about IP addresses &mdash; it's about removing the social layer of identity. Traditional social platforms build a persistent profile: your post history, your follower count, your real name attached to everything you've ever said. That accumulated profile is what gets used for targeting, harassment, and reputation tracking over time."),
        p("Removing usernames breaks that accumulation. Each post is judged on its own content, not against a history someone can scroll back through. That's a meaningfully different kind of privacy than &quot;no one can trace this,&quot; and it's the one anonymous boards actually deliver on."),
        h2("What still identifies you"),
        p("A few things can undercut anonymity even on a board with no accounts:"),
        ul([
            "Writing style &mdash; distinctive phrasing or topics can link posts to a known identity over time",
            "Posting personal details within the content itself",
            "Using the same device or network pattern across contexts where you're also identified elsewhere",
            "Screenshots that get shared outside the platform",
        ]),
        h2("The trade-off"),
        p(f"Removing identity also removes the usual social cost of bad behavior &mdash; which is exactly why moderation matters more on anonymous boards, not less. See our {link(ROOT + 'guidelines.html', 'Community Guidelines')} for how we handle that trade-off on InteractInk."),
    ],
    [
        ("Can InteractInk see who I am?", "We don't collect a name or account, but standard server logs (IP, timestamp) are kept briefly for abuse prevention, per our Privacy Policy."),
        ("Is anonymous the same as untraceable?", "No. Anonymous means no persistent profile is built. It doesn't mean technically untraceable under all circumstances."),
    ]
)
ARTICLES.append(("how-anonymous-posting-works.html", "How Anonymous Posting Actually Works",
    "What anonymity on a text board really protects you from, and what it doesn't.", "network", content))

# ============================================================= 2
content = article_wrap(
    "Tripcodes Explained: A Practical Guide", "key",
    "The tripcode system is the feature I probably explain the most in feedback emails, so I wrote this to save both of us time &mdash; it's the single most misunderstood part of the board.",
    [
        p(f"If you've replied to a thread on InteractInk, you've probably noticed a short tag like {code('Anon#a1b2')} attached to your name. That's a tripcode, and it solves a specific problem: how do you follow a conversation between anonymous people without anyone having an account?"),
        h2("The problem it solves"),
        p("Picture a thread where five different people are all posting as &quot;Anonymous.&quot; Without any way to tell them apart, a reply like &quot;I disagree with you&quot; is ambiguous &mdash; disagree with whom? Tripcodes give each participant a short, consistent tag for that thread so readers can follow who's replying to whom, without anyone revealing a real identity."),
        h2("How it's generated"),
        p("The tag is derived automatically from technical data tied to your session, run through a one-way transformation so the tag itself can't be reversed to reveal anything about you. Two people posting in the same thread will reliably get different tags, and the same person will keep the same tag for the duration of that thread &mdash; but the tag doesn't persist across different threads or across visits."),
        h2("What a tripcode is not"),
        ul([
            "It's not an account &mdash; there's no password, no login, nothing to recover if you lose it",
            "It's not permanent identity &mdash; it typically resets between sessions or threads",
            "It's not proof of anything &mdash; anyone can end up with a similar-looking tag by coincidence, since the tag space is limited",
        ]),
        h2("The short version"),
        p("A tripcode is a lightweight way to tell anonymous voices apart within a single conversation. It's a readability tool, not an identity system."),
    ],
    [
        ("Can I keep the same tripcode across threads?", "Not by default. Some boards support passphrase-based tripcodes for continuity; check the compose box for that option."),
        ("Can two people get the same tripcode?", "It's possible, since the tag space is limited &mdash; treat it as a readability aid, not a guarantee of uniqueness."),
    ]
)
ARTICLES.append(("tripcodes-explained.html", "Tripcodes Explained: A Practical Guide",
    "How InteractInk's tripcode system works, and what it doesn't do.", "key", content))

# ============================================================= 3
content = article_wrap(
    "Online Privacy Basics for Anonymous Communities", "shield",
    "I've moderated enough reports over the life of this board to notice a pattern: almost every &quot;I got doxxed&quot; message traces back to a detail the person posted themselves, not a platform failure. This article is the advice I actually give people.",
    [
        p("Using an anonymous board is one small piece of a much bigger picture. If privacy matters to you, it's worth understanding the basics that apply well beyond any single platform."),
        h2("Anonymity is contextual, not absolute"),
        p("You can be anonymous on a specific platform while still being identifiable through other means &mdash; your internet provider, your device, or details you share in the content itself. Treat &quot;no account required&quot; as one layer of privacy, not a guarantee that nothing about your activity is knowable."),
        h2("Don't self-identify accidentally"),
        p("The most common way people lose anonymity on any board isn't a technical failure &mdash; it's including identifying details in a post: a workplace, a hometown, a specific and unusual personal story, or a screenshot with a username visible in the corner."),
        h2("Writing style is a fingerprint"),
        p("Over enough posts, distinctive habits &mdash; specific phrases, topics you return to, even punctuation patterns &mdash; can link anonymous posts to each other or to a known identity. This is a slow, cumulative risk rather than an immediate one, but it's real."),
        h2("Basic habits that help"),
        ul([
            "Use a browser with tracking protection enabled, or a privacy-focused browser",
            "Avoid reusing distinctive usernames or phrases across platforms where you're anonymous and platforms where you're not",
            "Be deliberate about what personal context you include in a post, even in passing",
            f"Understand a platform's data retention policy &mdash; see our {link(ROOT + 'privacy.html', 'Privacy Policy')}",
        ]),
    ],
    [
        ("Does deleting a post remove it everywhere?", "It removes it from the board, but not from any screenshots or copies others may have already made."),
        ("Is a VPN necessary to use InteractInk?", "No, it's not required. It's an extra layer some people choose for additional privacy, not something the board depends on."),
    ]
)
ARTICLES.append(("online-privacy-basics.html", "Online Privacy Basics for Anonymous Communities",
    "Practical privacy habits for anyone using anonymous platforms.", "shield", content))

# ============================================================= 4
content = article_wrap(
    "A Short History of Anonymous Message Boards", "timeline",
    "I didn't build InteractInk in a vacuum &mdash; I spent a lot of time reading old BBS documentation before writing a line of code, and it changed some early decisions about how strict the moderation model should be.",
    [
        p("Anonymous posting is often talked about as if it's a recent, internet-native idea, but the underlying format has a longer and more varied history than people usually give it credit for."),
        h2("Bulletin boards and early forums"),
        p("Long before modern social platforms required a profile to participate, dial-up bulletin board systems (BBS) in the 1980s and early internet forums in the 1990s often allowed posting under simple, disposable handles."),
        h2("The imageboard model"),
        p("The format most people associate with &quot;anonymous board&quot; today traces back to Japanese imageboards in the early 2000s, which popularized posting without any account at all, with each thread built entirely around the content rather than who posted it."),
        h2("Why the model persisted"),
        p("Account-based social media became the dominant model by the 2010s, built around persistent profiles and algorithmic feeds tied to identity. Anonymous boards stayed relevant as a counter-model precisely because they don't do any of that."),
        h2("The recurring challenge"),
        p(f"Every generation of anonymous board has faced the same core tension: removing identity lowers the barrier to participation, but it also removes the usual social cost of bad behavior. See our {link(ROOT + 'guidelines.html', 'Community Guidelines')} for how we handle that."),
    ],
    [
        ("Is InteractInk based on any specific older board?", "It draws general lessons from the format's history rather than copying any one platform's code or design."),
        ("Why don't more mainstream platforms use this model?", "Persistent identity is central to how most social platforms monetize and moderate at scale, which pulls them away from the anonymous-board format."),
    ]
)
ARTICLES.append(("history-of-anonymous-boards.html", "A Short History of Anonymous Message Boards",
    "From BBS systems to imageboards: where the anonymous board format came from.", "timeline", content))

# ============================================================= 5
content = article_wrap(
    "How to Use InteractInk Safely", "checklist",
    "This is essentially the guide I wish existed when I posted my first thread anywhere anonymous years ago &mdash; the mistakes here are ones I've made myself, not just ones I've seen others make.",
    [
        p("A quick, practical guide to getting the most out of an anonymous board without running into avoidable problems."),
        h2("Before you post"),
        ul([
            "Re-read your post for identifying details you didn't mean to include",
            "Check the thread's existing tone &mdash; replying constructively gets better engagement than piling onto an already heated thread",
            "Remember posts are public and can be screenshotted",
        ]),
        h2("Understanding tripcodes"),
        p(f"If you want to be recognizable across a single thread without an account, the automatic tripcode does that for you. See {link(ROOT + 'blog/tripcodes-explained.html', 'Tripcodes Explained')} for details."),
        h2("Using reply anchors"),
        p("Typing &gt;&gt; followed by a post ID links directly to that post, which keeps threads readable even when several conversations are happening at once."),
        h2("If you see something that breaks the rules"),
        p(f"Use the Report link on the specific post. See our {link(ROOT + 'guidelines.html', 'Community Guidelines')} for what qualifies."),
    ],
    [
        ("What happens after I report a post?", "It goes into a review queue; violating posts are removed and repeat offenders can be blocked at the network level."),
        ("Can I edit a post after submitting?", "No &mdash; there are no accounts to tie an edit history to, so posts are final once submitted. Re-read before posting."),
    ]
)
ARTICLES.append(("how-to-use-interactink-safely.html", "How to Use InteractInk Safely",
    "A practical guide to posting, replying, and reporting on the board.", "checklist", content))

# ============================================================= 6 (NEW)
content = article_wrap(
    "Why Some People Prefer Boards Over Social Media", "chat",
    "I run both an Instagram-style account and this board, and the difference in how people write on each still surprises me &mdash; the board consistently gets longer, more thought-out replies.",
    [
        p("Feed-based social media and thread-based boards aren't just different layouts &mdash; they encourage genuinely different kinds of conversation, and it's worth understanding why before assuming one is simply an outdated version of the other."),
        h2("Feeds reward frequency, threads reward depth"),
        p("A social feed is optimized for a constant stream of short posts, because the algorithm needs fresh content to rank. A thread-based board has no feed to feed &mdash; a thread stays relevant as long as people are actively replying to it, which tends to reward longer, more developed exchanges over quick reactions."),
        h2("No follower count changes the incentive"),
        p("On platforms built around followers, what you post is shaped, consciously or not, by what will perform well with your existing audience. On an anonymous board, there's no audience to build or protect. A post succeeds or fails purely on whether people find it worth replying to, not on your history."),
        h2("Threads have a beginning and an end"),
        p("A social feed is functionally endless. A thread on a board has a clear boundary &mdash; it starts with a post, develops through replies, and eventually stops getting activity. That structure makes it easier to read a full conversation start to finish instead of scrolling through a stream with no defined edges."),
        h2("This isn't a replacement, it's a different tool"),
        p("None of this means boards are &quot;better&quot; than feeds &mdash; they serve different purposes. Feeds are good for quick updates and broad reach. Boards are better suited to focused discussion where the conversation itself is the point, not the reach."),
    ],
    [
        ("Is InteractInk trying to replace social media?", "No &mdash; it's built for a different kind of conversation, not as a general social media replacement."),
        ("Why are threads better for long discussions?", "Because they have a clear structure &mdash; a start, a developing set of replies, and a natural end &mdash; instead of an endless, algorithmically reordered stream."),
    ]
)
ARTICLES.append(("why-boards-over-social-media.html", "Why Some People Prefer Boards Over Social Media",
    "How thread-based discussion differs from algorithmic social feeds, and why that matters.", "chat", content))

# ============================================================= 7 (NEW)
content = article_wrap(
    "Understanding IP Logging and What It Means for You", "key",
    "This is the question I get asked most bluntly in the Contact inbox: &quot;can you see my IP?&quot; The honest answer deserves more than a one-line reply, so here it is in full.",
    [
        p("IP logging is one of the most misunderstood parts of running any website, anonymous or not. Here's what it actually involves, in plain terms, and why it exists even on a board designed around anonymity."),
        h2("What an IP address actually tells a site operator"),
        p("An IP address identifies the network connection your device is using at a given moment &mdash; often a rough geographic region and your internet provider. It doesn't hand over your name, and on its own it usually can't be traced to a specific individual without a legal request to the provider."),
        h2("Why any site logs it at all"),
        p("Basic web server software logs connection data as a byproduct of normal operation, not as a special surveillance feature. This data is what makes it possible to block abusive traffic, investigate spam waves, and respond to legal requests when required &mdash; without it, a board would have no way to stop coordinated abuse."),
        h2("What logging isn't"),
        p("Logging an IP address is not the same as building a profile of you. Without a persistent account or login, there's no mechanism tying that IP to a name, an email, or a history of everything you've posted across the site."),
        h2("What you can do if this matters to you"),
        ul([
            "Use a VPN if you want an added layer between your connection and the platform",
            f"Read a platform's Privacy Policy for exactly what's logged and for how long &mdash; see {link(ROOT + 'privacy.html', 'ours')}",
            "Avoid pairing anonymous posts with identifying details, which matters more than IP logging in practice",
        ]),
    ],
    [
        ("Does InteractInk sell IP or log data?", "No. Logs are used for abuse prevention and legal compliance only, as described in our Privacy Policy."),
        ("How long is log data kept?", "See our Privacy Policy for the current retention period &mdash; it's kept only as long as needed for its stated purpose."),
    ]
)
ARTICLES.append(("understanding-ip-logging.html", "Understanding IP Logging and What It Means for You",
    "A plain-language explanation of what IP logging does and doesn't reveal.", "key", content))

# ============================================================= 8 (NEW)
content = article_wrap(
    "A Beginner's Guide to Reading and Posting on InteractInk", "checklist",
    "I still remember watching a friend try the board for the first time and get confused by the reply-linking syntax within ten seconds &mdash; that reaction is the reason this guide exists.",
    [
        p("If you're new to thread-based anonymous boards, the layout and conventions can look unfamiliar at first. This walks through exactly how to read and participate in a thread."),
        h2("Starting a thread"),
        p("A thread begins with a single post &mdash; an optional name field and a body. That first post sets the topic; everything after it is a reply building on that topic."),
        h2("Reading a thread"),
        p("Replies appear underneath the original post, generally in the order they were made. Each reply carries a short ID and, if the poster is replying to someone specific, a link back to that earlier post."),
        h2("Replying to a specific post"),
        p("Type &gt;&gt; followed by the 8-character post ID at the start of your reply to link it to a specific earlier post. This keeps multi-person conversations readable, since it's clear who's responding to what."),
        h2("Posting for the first time"),
        ul([
            "The name field is optional &mdash; leave it blank to post as Anonymous",
            "Keep the body focused on the thread's topic for the first reply or two",
            "Check the character limit shown near the compose box before submitting",
        ]),
        h2("What happens after you post"),
        p("Your post appears in the thread immediately, tagged with a short tripcode so others can follow the conversation. There's no edit function, so it's worth a quick re-read before hitting submit."),
    ],
    [
        ("Do I need to make an account first?", "No. You can read and post immediately with no sign-up."),
        ("What if I make a mistake in a post?", "Posts can't be edited after submitting. If it's a serious issue, contact us with the post ID."),
    ]
)
ARTICLES.append(("beginners-guide-to-interactink.html", "A Beginner's Guide to Reading and Posting on InteractInk",
    "A step-by-step walkthrough for first-time visitors to the board.", "checklist", content))

# ============================================================= 9 (NEW)
content = article_wrap(
    "The Ethics of Moderating an Anonymous Community", "shield",
    "The hardest moderation call I've made on this board wasn't a clear rule-breaker &mdash; it was a borderline post where removing it felt like overreach and leaving it up felt irresponsible. There's no clean formula for that.",
    [
        p("Moderating a board where nobody has a persistent identity raises different questions than moderating a platform built around named accounts. Here's how we think about it."),
        h2("Judging the post, not the person"),
        p("Without accounts, there's no history to weigh a decision against &mdash; no &quot;this user has been reasonable before.&quot; Every post is evaluated on its own content against the same standard. That's fairer in some ways and harder in others, since context that would normally soften a judgment call isn't available."),
        h2("Consistency matters more without identity"),
        p("On a platform with visible usernames, inconsistent moderation eventually becomes visible as a pattern tied to specific people. On an anonymous board, that same inconsistency is invisible turn by turn, which means it's on the moderator to hold a consistent line deliberately, not rely on it becoming obvious."),
        h2("Removing content vs. removing access"),
        p("Removing a single post and blocking an IP address are different levels of response, and treating every violation as the latter would be disproportionate. Most moderation on InteractInk is post-level removal; network-level blocking is reserved for repeated or severe violations."),
        h2("Transparency without compromising the system"),
        p(f"We publish our {link(ROOT + 'guidelines.html', 'Community Guidelines')} so the standard is visible ahead of time, rather than only becoming apparent after something gets removed."),
    ],
    [
        ("Who decides what gets removed?", "Reported posts are reviewed against our published Community Guidelines by the site operator."),
        ("Can a removal be appealed?", "Yes &mdash; email us with the post ID and a brief explanation if you believe a removal was made in error."),
    ]
)
ARTICLES.append(("ethics-of-moderating-anonymous-community.html", "The Ethics of Moderating an Anonymous Community",
    "How moderation decisions get made when there's no user history to weigh them against.", "shield", content))

# ============================================================= 10 (NEW)
content = article_wrap(
    "Common Anonymous Board Terms Explained", "network",
    "I put this glossary together after answering the same three terms in Contact emails often enough that I started just linking people here instead.",
    [
        p("A short reference for terminology that shows up on InteractInk and similar boards, for anyone who's new to the format."),
        h2("Thread"),
        p("A single conversation, starting with one original post and continuing through replies underneath it."),
        h2("OP (Original Post)"),
        p("The first post in a thread, which sets the topic everything else responds to."),
        h2("Tripcode"),
        p(f"A short, automatically generated tag (like {code('Anon#a1b2')}) that lets readers tell different anonymous posters apart within a single thread. See {link(ROOT + 'blog/tripcodes-explained.html', 'Tripcodes Explained')} for the full breakdown."),
        h2("Reply anchor (&gt;&gt;)"),
        p("Typing &gt;&gt; followed by a post ID creates a clickable link back to that specific post, showing what a reply is responding to."),
        h2("Lurking"),
        p("Reading threads without posting. Completely normal, and the majority of visitors to most boards do this most of the time."),
        h2("Bumping"),
        p("Replying to a thread to keep it active and visible, as opposed to letting it go quiet from inactivity."),
    ],
    [
        ("Is this terminology specific to InteractInk?", "Most of it is common across anonymous board platforms generally, not unique to us."),
        ("Do I need to know these terms to use the board?", "No &mdash; the board works fine without them, but they help when reading discussions about how it works."),
    ]
)
ARTICLES.append(("anonymous-board-terms-explained.html", "Common Anonymous Board Terms Explained",
    "A glossary of terms you'll see used across anonymous text boards.", "network", content))

# ============================================================= 11 (NEW)
content = article_wrap(
    "How to Spot and Avoid Scams on Anonymous Boards", "shield",
    "I've pulled down more fake giveaway threads in the first few months of running this board than I expected to &mdash; enough that I think this deserves its own page rather than a line in the FAQ.",
    [
        p("Anonymity removes some social friction, and unfortunately that includes the friction that normally slows down scams. Here's what to watch for."),
        h2("Unsolicited financial opportunities"),
        p("Any thread promising guaranteed returns, free money for a small upfront payment, or an urgent limited-time investment is a scam pattern regardless of platform. The anonymity of the board doesn't make these more credible &mdash; it just means there's no account history to check before you engage."),
        h2("Requests to move off-platform quickly"),
        p("A common tactic is pushing a conversation to a private channel outside the board almost immediately. Be cautious of any exchange that pressures you to continue somewhere less visible before you've had a chance to evaluate it."),
        h2("Fake giveaways and impersonation"),
        p("Threads claiming to be an official giveaway, verification process, or support contact are a recurring pattern on anonymous platforms, precisely because there's no verified badge or account history to contradict the claim."),
        h2("Malicious links and downloads"),
        p(f"Never download a file or run software linked from a post promising something valuable in return. This is explicitly against our {link(ROOT + 'guidelines.html', 'Community Guidelines')} and should be reported immediately."),
        h2("If you encounter one"),
        p("Don't engage, don't click, and use the Report link so it can be removed before others fall for it."),
    ],
    [
        ("Does InteractInk run official giveaways?", "No. Any thread claiming to be an official InteractInk giveaway is not legitimate &mdash; report it."),
        ("What should I do if I already clicked a suspicious link?", "Run a security scan on your device and change any passwords you may have entered on the linked page."),
    ]
)
ARTICLES.append(("spot-avoid-scams-anonymous-boards.html", "How to Spot and Avoid Scams on Anonymous Boards",
    "Common scam patterns on anonymous platforms and how to recognize them early.", "shield", content))

# ============================================================= 12 (NEW)
content = article_wrap(
    "Why We Don't Require Accounts (And What That Costs Us)", "key",
    "Every few months someone emails asking why we don't just add optional accounts for people who want them. It's a fair question, and I think it deserves a real answer instead of a shrug.",
    [
        p("Building a board with no accounts is a deliberate trade-off, not an oversight. It's worth being honest about what we gain from that choice and what it costs us."),
        h2("What we gain"),
        p("No accounts means no persistent profile to build, track, or eventually leak in a breach. It means posts are judged on content rather than reputation. It means signing up takes zero seconds because there's nothing to sign up for."),
        h2("What it costs"),
        p("It also means we can't offer saved preferences, followed threads, or a personal post history &mdash; features that make plenty of platforms genuinely more convenient. Moderation is harder without account-level history to spot repeat bad actors quickly. And every legitimate user loses the ability to build a reputation over time, along with every bad actor losing the same thing."),
        h2("Why we made this trade anyway"),
        p("The board exists specifically for people who want a lower-friction, lower-footprint way to participate in discussion. Adding optional accounts would dilute that core purpose and complicate a system that's intentionally simple."),
        h2("Could this change?"),
        p(f"If we ever add optional features here, they'll be opt-in and clearly separated from the anonymous-by-default experience &mdash; not a requirement layered on top of it. Feedback on this is genuinely welcome via our {link(ROOT + 'contact.html', 'Contact page')}."),
    ],
    [
        ("Will InteractInk ever require accounts?", "No plan to require them. The anonymous-by-default model is core to the board."),
        ("Can I suggest a feature?", "Yes &mdash; use the Contact page. Feature requests are read even if we can't reply to every one individually."),
    ]
)
ARTICLES.append(("why-no-accounts.html", "Why We Don't Require Accounts (And What That Costs Us)",
    "An honest look at the trade-offs behind InteractInk's account-free design.", "key", content))

# ============================================================= 13 (NEW)
content = article_wrap(
    "What Makes a Good Anonymous Thread", "chat",
    "Looking back at which threads on this board actually got thoughtful, sustained replies versus which ones died after two comments, a pretty consistent pattern emerged &mdash; and it's not what I expected going in.",
    [
        p("Not every thread takes off, and it's rarely about the topic alone. A few patterns consistently separate threads that get real discussion from ones that fizzle out."),
        h2("A specific, answerable opening post"),
        p("Vague prompts like &quot;thoughts?&quot; tend to get vague replies or none at all. A specific question or a clearly stated position gives people something concrete to respond to."),
        h2("Room for disagreement"),
        p("Threads that only leave space for agreement tend to run out of things to say quickly. A post that acknowledges a counterpoint, or leaves a genuine question open, tends to draw more sustained back-and-forth."),
        h2("Early replies set the tone"),
        p("The first two or three replies in a thread tend to determine whether it stays constructive or devolves. Replying thoughtfully early on &mdash; rather than with a one-line dismissal &mdash; noticeably changes how the rest of the thread goes."),
        h2("Length isn't the point, specificity is"),
        p("A short, precise post that raises a genuine question often outperforms a long post that doesn't clearly ask anything. Readers respond to what they can engage with, not to length."),
        h2("Using reply anchors keeps momentum going"),
        p(f"Threads that use {code('&gt;&gt;ID')} anchors to reply to specific points tend to stay organized even as they grow, compared to threads where replies pile up without clear reference to what they're responding to."),
    ],
    [
        ("Does thread length affect visibility?", "Active threads with recent replies tend to surface higher in a Latest or Trending view, not length on its own."),
        ("What's the fastest way to get a thread ignored?", "Vague, low-effort openers with nothing specific to respond to tend to get skipped."),
    ]
)
ARTICLES.append(("what-makes-a-good-anonymous-thread.html", "What Makes a Good Anonymous Thread",
    "Patterns behind threads that get real discussion versus ones that fizzle out.", "chat", content))

# ---------------------------------------------------------------- BUILD ALL ARTICLES
for fname, title, desc, banner, content in ARTICLES:
    build_page(f"blog/{fname}", f"{title} - InteractInk", desc, "Blog", content, active="blog", root=ROOT)

# ---------------------------------------------------------------- BLOG INDEX
rows = ""
for fname, title, desc, banner, content in ARTICLES:
    rows += f"""
    <a href="{fname}" class="block p-4 hover:bg-neutral-950/50 transition border-b border-neutral-800">
        <h3 class="text-white font-bold text-sm mb-1">{title}</h3>
        <p class="text-neutral-500 text-xs leading-relaxed">{desc}</p>
    </a>"""

blog_index_content = f"""
{p("Notes on anonymity, privacy, and how InteractInk works.")}
<div class="border border-neutral-800 rounded-xl overflow-hidden divide-y divide-neutral-800 mt-4">
{rows}
</div>
"""

build_page(
    "blog/index.html", "Blog - InteractInk",
    "Articles on anonymity, online privacy, and how InteractInk works.",
    "Blog", blog_index_content, active="blog", root=ROOT
)

print(f"\nBuilt {len(ARTICLES)} articles + blog index")
