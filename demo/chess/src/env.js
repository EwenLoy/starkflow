/**
 * Address the built page talks to. This default is what the project itself
 * shows in public (footer, help, README). A real deployment overrides it at
 * build time: `STARKFLOW_WS_URL` in the environment, or a git-ignored
 * `demo/chess/.env`, and `scripts/build.mjs` rewrites this file inside `dist/`.
 */
export const WS_URL = 'wss://starkflow.orkestr.run/ws';
