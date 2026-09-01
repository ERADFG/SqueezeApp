// ─────────────────────────────────────────────────────────────
// SUPABASE CONFIG
// Fill these in with your own project's values.
// Find them in: Supabase Dashboard → Project Settings → API
// SUPABASE_ANON_KEY is the public "anon" key — it is safe to
// expose in client-side code as long as Row Level Security (RLS)
// policies are enabled on every table (they are, see schema.sql).
// Never put your service_role key in frontend code.
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://pyitivzoqleukuclajrf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5aXRpdnpvcWxldWt1Y2xhanJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzg0ODcsImV4cCI6MjEwMTU1NDQ4N30.gKvqOaAREY5wcptIv7OHfjHhZR5ogIaMY8I98jHRmFs';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MEDIA_BUCKET = 'media';
const MAX_FILE_MB = 100;
// Separate cap for profile/community/List avatars (square crops —
// see js/crop-modal.js's openCropModal), so it can be tuned
// independently of the general upload cap above if the two ever need
// to diverge.
const AVATAR_MAX_MB = 100;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
