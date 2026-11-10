// A plugin's input map: a standard gamepad's buttons and sticks pressed as
// keys, for a game that only reads the keyboard. The preview's bridge in the
// game's page polls the pad and sends `KeyboardEvent`s while the page has
// focus, and lets every key go on blur, on disconnect and when the map goes.

/** The standard mapping's buttons, by their index in `Gamepad.buttons`. */
export const GAMEPAD_BUTTONS = [
  "a", "b", "x", "y",
  "leftBumper", "rightBumper", "leftTrigger", "rightTrigger",
  "back", "start", "leftStick", "rightStick",
  "up", "down", "left", "right", "home",
] as const;
export type GamepadButton = (typeof GAMEPAD_BUTTONS)[number];

export const GAMEPAD_STICKS = ["left", "right"] as const;
export const STICK_DIRECTIONS = ["up", "down", "left", "right"] as const;

/** `KeyboardEvent.code` values a map may press. */
export const KEY_CODE_PATTERN = "^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|Space|Enter|Escape|Tab|Backspace|(?:Shift|Control|Alt)(?:Left|Right)|F(?:[1-9]|1[0-2]))$";

export const DEFAULT_DEAD_ZONE = 0.5;

/** A map as the manifest gives it. */
export interface InputMapDefinition {
  buttons?: Partial<Record<GamepadButton, string>>;
  sticks?: Partial<Record<(typeof GAMEPAD_STICKS)[number], Partial<Record<(typeof STICK_DIRECTIONS)[number], string>>>>;
  deadZone?: number;
}

/** A map as the bridge runs it: button indexes, and axis directions past the dead zone. */
export interface GamepadKeyMap {
  buttons: Array<[index: number, code: string]>;
  axes: Array<[axis: number, direction: -1 | 1, code: string]>;
  deadZone: number;
}

export function compileInputMap(map: InputMapDefinition): GamepadKeyMap {
  const buttons = GAMEPAD_BUTTONS.flatMap((button, index): GamepadKeyMap["buttons"] => {
    const code = map.buttons?.[button];
    return code ? [[index, code]] : [];
  });
  const axes: GamepadKeyMap["axes"] = [];
  GAMEPAD_STICKS.forEach((stick, stickIndex) => {
    const directions = map.sticks?.[stick];
    const x = stickIndex * 2;
    if (directions?.left) axes.push([x, -1, directions.left]);
    if (directions?.right) axes.push([x, 1, directions.right]);
    if (directions?.up) axes.push([x + 1, -1, directions.up]);
    if (directions?.down) axes.push([x + 1, 1, directions.down]);
  });
  return { buttons, axes, deadZone: map.deadZone ?? DEFAULT_DEAD_ZONE };
}

const keyCode = (value: unknown) => typeof value === "string" && new RegExp(KEY_CODE_PATTERN).test(value);

/** Whether `value` is a map the bridge can run, as it is sent across. */
export function isGamepadKeyMap(value: unknown): value is GamepadKeyMap {
  if (!value || typeof value !== "object") return false;
  const map = value as Partial<GamepadKeyMap>;
  return Array.isArray(map.buttons) && map.buttons.length <= GAMEPAD_BUTTONS.length &&
    map.buttons.every((entry) => Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) && entry[0] >= 0 && entry[0] < GAMEPAD_BUTTONS.length && keyCode(entry[1])) &&
    Array.isArray(map.axes) && map.axes.length <= 8 &&
    map.axes.every((entry) => Array.isArray(entry) && entry.length === 3 && Number.isInteger(entry[0]) && entry[0] >= 0 && entry[0] < 4 && (entry[1] === -1 || entry[1] === 1) && keyCode(entry[2])) &&
    typeof map.deadZone === "number" && map.deadZone >= 0.1 && map.deadZone <= 0.9;
}
