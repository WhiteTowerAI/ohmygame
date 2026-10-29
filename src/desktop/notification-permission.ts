import type { AgentNotificationPermission } from "../shared/agent-notifications.js";

const USER_NOTIFICATIONS = "/System/Library/Frameworks/UserNotifications.framework/UserNotifications";
const FOUNDATION = "/System/Library/Frameworks/Foundation.framework/Foundation";
/** `UNAuthorizationOptionBadge | UNAuthorizationOptionSound | UNAuthorizationOptionAlert`. */
const BADGE_SOUND_ALERT = 7;
const SETTINGS_TIMEOUT_MS = 5_000;
const MAC_SETTINGS_URL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
const WINDOWS_SETTINGS_URL = "ms-settings:notifications";

/** What `UNNotificationSettings` reports. */
export interface MacNotificationSettings {
  authorizationStatus: number;
  alertStyle: number;
}

/** The parts of `UNUserNotificationCenter` the app uses. */
export interface MacNotificationCenter {
  bundleId: string | null;
  settings(): Promise<MacNotificationSettings>;
  /** Shows the system prompt while the user has not decided; resolves with whether notifications are allowed. */
  requestAuthorization(): Promise<boolean>;
}

/**
 * The system notification permission. Electron can neither read it nor ask
 * for it on macOS, so this calls `UNUserNotificationCenter` through objc-js,
 * the only module of the app that does.
 */
export class NotificationPermission {
  #center: Promise<MacNotificationCenter | undefined> | undefined;
  #askedThisLaunch = false;

  constructor(private readonly options: {
    platform: NodeJS.Platform;
    /** Only a packaged app has its own permission; development builds share Electron's. */
    packaged: boolean;
    openExternal: (url: string) => Promise<void>;
    loadCenter?: () => Promise<MacNotificationCenter>;
    log?: (message: string) => void;
  }) {}

  async status(): Promise<AgentNotificationPermission> {
    if (this.options.platform !== "darwin") return "unknown";
    const center = await this.#loadCenter();
    if (!center) return "unavailable";
    try {
      return permissionFromSettings(await center.settings());
    } catch (error) {
      this.options.log?.(`Could not read the notification permission: ${error}`);
      return "unavailable";
    }
  }

  /** Shows the system prompt if the user has not decided yet. The system shows it at most until they choose. */
  async request(): Promise<AgentNotificationPermission> {
    const status = await this.status();
    if (status !== "not-determined") return status;
    try {
      await (await this.#loadCenter())?.requestAuthorization();
    } catch (error) {
      this.options.log?.(`Could not request notification permission: ${error}`);
    }
    return this.status();
  }

  /** Asks once per launch, when the user sends a prompt; a closed prompt is asked again on the next launch. */
  async requestOncePerLaunch(): Promise<AgentNotificationPermission> {
    if (this.#askedThisLaunch) return this.status();
    this.#askedThisLaunch = true;
    return this.request();
  }

  async openSettings(): Promise<void> {
    if (this.options.platform === "win32") return this.options.openExternal(WINDOWS_SETTINGS_URL);
    if (this.options.platform !== "darwin") return;
    const bundleId = (await this.#loadCenter())?.bundleId;
    await this.options.openExternal(bundleId ? `${MAC_SETTINGS_URL}?id=${encodeURIComponent(bundleId)}` : MAC_SETTINGS_URL);
  }

  #loadCenter(): Promise<MacNotificationCenter | undefined> {
    if (!this.options.packaged) return Promise.resolve(undefined);
    this.#center ??= (this.options.loadCenter ?? loadMacNotificationCenter)().catch((error: unknown) => {
      this.options.log?.(`Could not load the macOS notification center: ${error}`);
      return undefined;
    });
    return this.#center;
  }
}

/** Maps `UNAuthorizationStatus` and `UNAlertStyle` to what the settings page shows. */
export function permissionFromSettings(settings: MacNotificationSettings): AgentNotificationPermission {
  switch (settings.authorizationStatus) {
    case 0: return "not-determined";
    case 1: return "denied";
    // Provisional: delivered quietly until the user keeps or turns them off.
    case 3: return "quiet";
    // Authorized or ephemeral; an alert style of none means no banners.
    default: return settings.alertStyle === 0 ? "quiet" : "allowed";
  }
}

/** The objc-js calls this module makes; it is installed only on macOS. */
interface ObjcBridge {
  NobjcLibrary: new (path: string) => Record<string, ObjcObject>;
  typedBlock: <T extends (...args: never[]) => void>(signature: { returns: string; args: string[] }, fn: T) => T;
}

type ObjcObject = Record<string, (...args: unknown[]) => ObjcObject & { toString(): string }>;

async function loadMacNotificationCenter(): Promise<MacNotificationCenter> {
  // A variable keeps TypeScript from resolving the module on systems that do not install it.
  const specifier = "objc-js";
  const { NobjcLibrary, typedBlock } = await import(specifier) as ObjcBridge;
  const center = new NobjcLibrary(USER_NOTIFICATIONS).UNUserNotificationCenter!.currentNotificationCenter!();
  const bundleId = new NobjcLibrary(FOUNDATION).NSBundle!.mainBundle!().bundleIdentifier!();
  return {
    bundleId: bundleId ? bundleId.toString() : null,
    settings: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No answer from the notification center")), SETTINGS_TIMEOUT_MS);
      center.getNotificationSettingsWithCompletionHandler$!(typedBlock({ returns: "v", args: ["@"] }, (settings: ObjcObject) => {
        clearTimeout(timer);
        resolve({
          authorizationStatus: Number(settings.authorizationStatus!()),
          alertStyle: Number(settings.alertStyle!()),
        });
      }));
    }),
    // No timeout: the system prompt waits for the user.
    requestAuthorization: () => new Promise((resolve, reject) => {
      center.requestAuthorizationWithOptions$completionHandler$!(BADGE_SOUND_ALERT, typedBlock({ returns: "v", args: ["B", "@"] }, (granted: boolean, error: ObjcObject | null) => {
        if (error) reject(new Error(error.localizedDescription!().toString()));
        else resolve(Boolean(granted));
      }));
    }),
  };
}
