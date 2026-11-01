---
name: game-ui-frontend
description: Design browser-game visual mockups and implement restrained, themed HUDs and menus with generated art, responsive layouts, touch controls, and clear feedback.
---

# Game UI Frontend

Build interface surfaces that support play rather than turning the game into a generic dashboard. Preserve an established visual language when modifying an existing game.

## Visual Direction

Before substantial UI work, identify the game's fantasy, camera, primary actions, information hierarchy, material language, typography, palette, and motion tone. Use CSS variables for shared theme values.

Make mockups depict real gameplay information and actions. Carry the world's shapes, materials, and palette into icons, frames, and buttons.

## Layout Rules

- Protect the center and primary action area of the playfield.
- Keep only information needed for current decisions persistent. Group secondary information and rare actions in contextual panels or the pause menu; avoid simultaneous button strips along the top, side, and bottom.
- Prefer icons with values or short labels. Keep short labels for unfamiliar icons and put explanations in tooltips, onboarding, or help. Use contextual prompts and transient feedback instead of permanent instruction panels.
- Keep HUD readable over motion without flattening the game beneath excessive panels or blur.
- Do not use landing-page heroes, SaaS dashboard grids, decorative card stacks, or large explanatory text over active play.

## UI Art

- Prefer generated art for theme-specific icons, button skins, frames, and panel textures when configured media tools are available. Reuse approved assets and shared visual references; check readability at actual gameplay scale.
- Keep dynamic text, numbers, layout, hit areas, and interaction states in code, using DOM for text-heavy surfaces unless the game requires in-world UI. Prepare transparent or scalable skins as needed; keep simple bars and geometric controls lightweight.

## Responsive And Input Behavior

- Design inside an iframe at both wide and narrow sizes without horizontal overflow.
- Respect safe areas and ensure the smallest supported viewport remains playable.
- Provide touch targets and control placement appropriate to mobile play when mobile is in scope.
- Pause or gate camera and gameplay input under menus, dialogs, and inventories.
- Make pointer lock, drag-look, focus, pause, and resume states explicit.
- Respect reduced-motion preferences for nonessential UI motion.

## Change Modes

- For a feature, connect UI state to the actual game-state owner rather than duplicating it locally.
- For a visual bug, reproduce the affected viewport and state before changing layout rules.
- For polish, favor a few meaningful transitions tied to danger, reward, state change, or onboarding.

Verify representative gameplay states on desktop and mobile viewports, including overlay open and closed states. Use `../game-playtest/SKILL.md` for structured visual QA.
