/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_B2_CDN_BASE: string;
  /** Optional. Where a DESKTOP build sends its /api/* calls; see lib/apiBase.ts.
   *  Never read on the web, where those routes are same-origin. */
  readonly VITE_API_BASE?: string;
  readonly VITE_MODEL_TIER?: "kaggle" | "runpod" | "aws";
  /** Optional. Crash reporting's ingest address — a SELECTOR with a default,
   *  not a credential: a DSN is write-only, grants no read and cannot be
   *  spent, which is why it may ship in the bundle at all. `""` disables
   *  reporting; see lib/sentry.ts. */
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The app's version, from package.json, injected by vite.config.js. Tags every
 *  Sentry event and names the release its source maps are uploaded under. */
declare const __APP_VERSION__: string;
