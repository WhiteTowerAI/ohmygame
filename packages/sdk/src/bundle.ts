// The core browser SDK a game copies in as client.js. It carries no room client: multiplayer
// games also copy multiplayer.js, which imports these shared modules from ./client.js.
export * from "./index.js";
export * from "./multiplayer-protocol.js";
/** @internal Shared with multiplayer.js, so both files use one copy; not part of the API. */
export { browserStorage, serviceRequest } from "./identity.js";
/** @internal Read by the rules runtime in multiplayer.js; not part of the API. */
export { isRealtimeGameDefinition } from "./define-game.js";
