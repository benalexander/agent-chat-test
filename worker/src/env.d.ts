// Secrets that are not always present in .dev.vars, so `wrangler types` can't always
// see them. Declared non-optional so this merges cleanly whether or not the generated
// worker-configuration.d.ts includes them; at runtime they may still be undefined, so
// always check them for falsiness (unset secret → fail closed / clear error).
declare namespace Cloudflare {
  interface Env {
    ANTHROPIC_API_KEY: string;
    ADMIN_SECRET: string;
    CF_AIG_TOKEN?: string;
  }
}
