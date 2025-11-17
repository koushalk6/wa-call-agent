# WhatsApp Call Handler (Cloud Run)

## What this does
- Receives WhatsApp Calling webhooks (user-initiated).
- Auto-answers calls by creating a WebRTC answer.
- Injects silent audio so the call stays active.

## Env vars
- VERIFY_TOKEN - webhook verification token (string)
- META_ACCESS_TOKEN - Meta Graph API token (string)
- META_API_VERSION - e.g., v17.0
- META_BASE_URL - (optional) default https://graph.facebook.com
- ANSWER_MODE - "CALL_SCOPED" (default) or "PHONE_SCOPED"
  - If CALL_SCOPED: code posts answer to `/{CALL_ID}/answer` and ICE to `/{CALL_ID}/ice_candidates`.
  - If PHONE_SCOPED: code posts to `/{PHONE_NUMBER_ID}/calls` with `{ type: 'answer' | 'ice_candidate', call_id, ... }`.

## Deploy to Cloud Run (basic)
1. Build and push:
