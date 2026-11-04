import { shell, type BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

/**
 * A published game playing in the desktop app signs its player in through a popup, as in a
 * browser (docs/game-sign-in.md). The app opens only the account service's sign-in page in
 * its own window, so a game cannot open arbitrary app windows, and any other link still goes
 * to the system browser. The popup must stay a child of the game's frame: the game hears
 * back from it through window.opener.
 */

/** The window name and path the SDK opens, in packages/sdk/src/account.ts. */
export const GAME_SIGN_IN_WINDOW_NAME = "ohmygame-sign-in";
const AUTHORIZE_PATH = "/v1/game-auth/authorize";

/**
 * The account service published games sign in with: the same choice the daemon makes for
 * their manifests, and only over HTTPS.
 */
export function gameSignInIssuer(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.OHMYGAME_ACCOUNT_ISSUER ?? environment.CLOUD_API_URL ?? environment.PUBLISH_API_URL;
  if (!value) return undefined;
  try {
    const url = new URL(value.replace(/\/+$/, ""));
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      ? url.href.replace(/\/+$/, "")
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a frame asks for the account service's sign-in page, in the SDK's sign-in window. */
export function isGameSignInRequest(
  details: { url: string; frameName: string },
  issuer: string | undefined,
): boolean {
  if (!issuer || details.frameName !== GAME_SIGN_IN_WINDOW_NAME) return false;
  try {
    const url = new URL(details.url);
    const expected = new URL(`${issuer}${AUTHORIZE_PATH}`);
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A plain web window: no preload or app access, like a browser popup. */
export const GAME_SIGN_IN_WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  width: 480,
  height: 680,
  minWidth: 360,
  minHeight: 480,
  autoHideMenuBar: true,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  },
};

/**
 * Sign-in passes through other sites, such as an identity provider, and returns to the
 * game's page, so the window may visit any HTTPS page. It opens no further windows; their
 * links go to the system browser.
 */
export function guardGameSignInWindow(child: BrowserWindow): void {
  const contents = child.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const secureOnly = (event: { preventDefault(): void }, url: string) => {
    if (!/^https:\/\//i.test(url)) event.preventDefault();
  };
  contents.on("will-navigate", secureOnly);
  contents.on("will-redirect", secureOnly);
}
