import Filter from "bad-words";
const filter = new Filter();

export async function POST(req) {
  const { text, imageUrl } = await req.json();

  // Layer 1: blocklist (text)
  if (text) {
    const flagged = filter.isProfane(text);
    if (flagged) {
      return Response.json({ allowed: false, reason: "blocklist" });
    }
  }

  // Layer 2: OpenAI Moderation (text + image, covers NSFW/sexual content)
  const input = [];
  if (text) input.push({ type: "text", text });
  if (imageUrl) input.push({ type: "image_url", image_url: { url: imageUrl } });

  if (input.length > 0) {
    const openaiRes = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input }),
    });
    const data = await openaiRes.json();
    const result = data.results[0];

    if (result.flagged) {
      return Response.json({ allowed: false, reason: "openai", categories: result.categories });
    }
  }

  return Response.json({ allowed: true });
}