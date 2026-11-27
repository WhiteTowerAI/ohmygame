# Game icons

These SVGs come unchanged from the `svg/no-padding/` folder of
[Nieobie/game-icon-pack](https://github.com/Nieobie/game-icon-pack) (commit
`b1a5fec`), released under CC0 1.0; see [LICENSE](LICENSE). Settings › About
credits the pack even though CC0 doesn't require it.

They mark content, not controls: project types, empty states and plugins
without their own icon. Render them through `GameIcon` in
`src/renderer/game-icon.tsx`, which draws one in a coloured rounded tile;
interface icons stay in `src/renderer/icons.ts`.

Add only icons the app uses, copied from the same folder with their names.
