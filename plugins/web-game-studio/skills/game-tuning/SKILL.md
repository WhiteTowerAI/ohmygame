---
name: game-tuning
description: Make a browser game's feel adjustable from the Tune panel, with sliders and toggles that change values while it runs, by moving constants into a tuning file and connecting the game to it.
---

# Game Tuning

Let the person change how the game plays while it runs. Move the values that shape it into a file, and have the game apply a new value at once, without restarting or losing its state.

## Choose The Values

Pick the 5 to 10 values that most shape how the game plays, such as jump height, gravity, speed, spawn rate or damage. Keep the current numbers, so the game plays the same until someone changes them. Choose a range wide enough to explore and narrow enough that every position still runs.

## The File

Use `public/tuning.json` when the project has a `public` folder, so builds include it; otherwise use `tuning.json` beside `index.html`.

```json
{
  "schemaVersion": 1,
  "values": [
    { "id": "player.jumpHeight", "label": "Jump height", "value": 420, "min": 100, "max": 800, "step": 10 },
    { "id": "world.doubleJump", "label": "Double jump", "value": false }
  ]
}
```

- `id` starts with a letter and uses letters, digits, `.`, `_` and `-`.
- `label` is what the person sees: write it in the language they use, in at most 80 characters.
- A number needs `min` and `max`, with `value` between them; `step` is optional. `true` or `false` makes a toggle.
- Other fields are kept when the person saves.

## Connect The Game

Read the file with `fetch`. Don't `import` it: a dev server reloads the page when an imported file changes, which loses the game's state.

```js
const tuning = {};
const file = await (await fetch("tuning.json")).json();
for (const item of file.values) tuning[item.id] = item.value;

window.__OHMYGAME_TUNING__ = {
  set(id, value) {
    tuning[id] = value;
  },
};
```

Resolve the path the way the project resolves its other public files, and keep a fallback so the game still starts if the request fails.

The game must use a new value straight away. Read `tuning[id]` each time the value is used. When something copies it once, such as a physics world's gravity or a spawn timer, apply it again inside `set`. A value that really can't change mid-game, such as a level's size, doesn't belong in the file.

The setter does nothing in a released game, because only the preview calls it.

## Verify

1. Open the Tune panel in the game toolbar. It should say the game is connected.
2. If `game_use` is available, check that the game still starts and plays with the file's values. It doesn't receive unsaved slider values, which keeps tests repeatable.
3. Ask the person to move a slider while the game runs, and to save the values they like.

Saved values are in the file, so read it before changing the game's balance.
