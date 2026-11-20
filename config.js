// Configure how recordings are uploaded.
//
// 1. LOCAL MODE (default when running `python -m tiny_med_pr_stt.recorder_server`):
//    Leave GOOGLE_APPS_SCRIPT_URL empty (""). Recordings POST to `/upload` on localhost.
//
// 2. GOOGLE DRIVE MODE (for sharing with friends/family via GitHub Pages / Cloudflare Pages):
//    Paste your deployed Google Apps Script Web App URL below.
window.RECORDER_CONFIG = {
  GOOGLE_APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzJ0iHwyAHWBUlqqkTqBMWYX408LpDq4OZu6Oejj-CFlpcAPLd3VCFAPAPSSNeCaU4N/exec",
  DEFAULT_PROMPTS_PER_SESSION: 25,
  REQUIRE_PIN_IN_LOCAL_MODE: false,
};
