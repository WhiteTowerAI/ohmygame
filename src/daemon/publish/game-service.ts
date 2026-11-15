/** OhMyGame's production cloud API, whose published games use OhMyGame's production game service. */
export const PRODUCTION_CLOUD_API_URL = "https://cloud.ohmygame.ai";
/** OhMyGame's production game service: rooms, cloud saves and leaderboards for published games. */
export const PRODUCTION_GAME_SERVICE_URL = "https://games.ohmygame.ai";

/**
 * The game service published games use. OHMYGAME_GAME_SERVICE_URL (or the older
 * MULTIPLAYER_PUBLISH_SERVER_URL) sets it; otherwise a desktop that publishes to OhMyGame's
 * production cloud uses the production game service, and any other cloud, such as a local or
 * test one, gets none rather than production's.
 */
export function gameServiceUrlFor(environment: NodeJS.ProcessEnv, cloudApiUrl: string | undefined): string | undefined {
  const configured = (environment.OHMYGAME_GAME_SERVICE_URL ?? environment.MULTIPLAYER_PUBLISH_SERVER_URL)?.trim();
  if (configured) return configured;
  return cloudApiUrl?.trim().replace(/\/+$/, "") === PRODUCTION_CLOUD_API_URL ? PRODUCTION_GAME_SERVICE_URL : undefined;
}
