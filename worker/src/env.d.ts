// Secrets that are not always present in .dev.vars, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    ANTHROPIC_API_KEY?: string;
    CF_AIG_TOKEN?: string;
  }
}
