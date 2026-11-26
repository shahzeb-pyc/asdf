import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Spec 214: web app on Cloudflare Workers via @opennextjs/cloudflare.
// Defaults suffice today: no ISR, so no R2 incremental cache is needed.
// Image-optimisation / caching options go here only if a live check
// demands them.
export default defineCloudflareConfig();
