// Supabase connection for the web app.
// These two values are SAFE to be public:
//   - the URL is not a secret
//   - the "publishable" (anon) key is designed for browsers; Row Level Security + login
//     are what actually protect the data. The SECRET key is NEVER used here.
window.VC_CONFIG = {
  SUPABASE_URL: 'https://hhshbogxymuscjtpwgpm.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_hex65tiCZl4prlhvJxOjYQ_DqYQUyWi',
};
