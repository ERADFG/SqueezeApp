import Filter from "bad-words";
const filter = new Filter();

// --- Doxing pattern check ---
function containsPossibleDoxxing(text) {
  const patterns = [
    /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,           // phone numbers
    /\b\d{3}-\d{2}-\d{4}\b/,                    // SSN format
    /\b\d{1,5}\s\w+\s(street|st|ave|avenue|road|rd|blvd|lane|ln)\b/i, // street address
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // email (context-dependent, may over-flag)
  ];
  return patterns.some(p => p.test(text));
}

// --- Dangerous link check (Google Safe Browsing) ---
async function checkDangerousLink(url) {
  const res = await fetch(
    `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${process.env.SAFE_BROWSING_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "interactink", clientVersion: "1.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: [{ url }],
        },
      }),
    }
  );
  const data = await res.json();
  return data.matches && data.matches.length > 0; // true = dangerous
}

// Pulls any http(s) URLs out of a block of text so each can be checked
function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s]+/g);
  return matches || [];
}

export async function POST(req) {
  const { text, imageUrl } = await req.json();

  // --- Layer 1: profanity blocklist ---
  if (text) {
    const flagged = filter.isProfane(text);
    if (flagged) {
      return Response.json({ allowed: false, reason: "blocklist" });
    }
  }

  // --- Layer 2: doxing pattern check ---
  if (text && containsPossibleDoxxing(text)) {
    return Response.json({ allowed: false, reason: "possible_doxxing" });
  }

  // --- Layer 3: dangerous link check ---
  if (text && process.env.SAFE_BROWSING_KEY) {
    const urls = extractUrls(text);
    for (const url of urls) {
      const dangerous = await checkDangerousLink(url);
      if (dangerous) {
        return Response.json({ allowed: false, reason: "dangerous_link", url });
      }
    }
  }

  return Response.json({ allowed: true });
}