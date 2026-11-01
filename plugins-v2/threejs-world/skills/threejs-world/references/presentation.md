# Themed presentation

Use this guide while expanding the design and implementing the page. It defines information hierarchy, readable composition, real navigation, and visual finish. Adapt the palette, typography, wording, region count, and decoration to the world; it is not a fixed theme or component framework.

The presentation is a showcase layer for an explorable world, not a gameplay HUD. It introduces the world on arrival and then gets out of the way once the visitor enters it.

## Page structure

The full-screen Three.js scene is the background and primary content. Arrange the presentation around its focal subjects with these roles:

| Placement | Content | Design and behavior |
| --- | --- | --- |
| Upper left | Small identity label, such as `FIELD NOTES / 001` | Establish the world's identity with restrained typography and spacing. |
| Left title area | Large title and an optional contrasting subtitle | Use a deliberate display style and clear hierarchy, leaving room for the hero silhouette. |
| Below the title | Short scene description and current-location description | Describe this specific world, and update the location text when navigation changes the selected view or region. |
| Upper right | Direction, coordinates, or a thematic marker | Any displayed direction or coordinates must match the camera and world state. A thematic marker may be static. |
| Lower navigation area | Translucent bar of review-view names | Include an overview, the main route, hero close-ups, and relevant regions. Every item must select a real camera view or route. |
| Entry action | Themed button, such as `ENTER WORLD` | Enter the starting view, begin a route, or activate the exploration mode. State which one the design intends. |
| Near the controls | Concise input hints | Match the active controls. `WASD to walk · Arrow keys to turn` is suitable only if those inputs work. |
| Behind text and navigation | Directional gradient masks and translucent panels | Keep text readable over moving scenery without hiding key geometry or flattening the image. |

Treat these as content roles, not a fixed set of panels or region names. Group or reposition them on narrow viewports while keeping the scene's focal hierarchy.

After the entry action, collapse or fade the title and description so the world fills the frame. Keep navigation, the current location, and control hints available, compact and away from the center of view. Provide a clear way back to the arrival view.

## Language

Write all visible text in the user's language: titles, descriptions, navigation, buttons, hints, loading and error messages, tooltips, dynamic labels, and any text rendered into the canvas. Follow the language of the user's request unless they ask for a different one, and keep it consistent across the page. Do not copy display wording from the worked example.

## Resolve the presentation in the design

Record the actual title, subtitle, identity label, scene copy, location descriptions, review-view names, entry text, and control hints. For each navigation item, specify its destination, its framing or route, and what the view should reveal. Define the entry action and how the location text and selected navigation state follow it. Camera jumps are valid review navigation, but they do not prove that a promised walking route is traversable.

Define a palette drawn from the world's materials and light, a display, body, and label typography hierarchy, the panel treatment, the mask direction, and the part of the frame reserved for the hero subject. Explain how these choices express the theme; swapping accent colors on an unrelated interface is not enough. Describe how titles, navigation, and hints reflow and how the subject stays visible on a narrow viewport.

## Implement and inspect

- Style buttons and navigation deliberately, with readable active and focus states. Decorative overlays must not intercept scene input, and interactive UI must stay operable by keyboard.
- Pause or gate world input while a menu or panel has focus.
- Wire every navigation item and the entry action to the specified behavior. Update the location text and active selection, and keep control hints accurate when modes change.
- Preserve the full-screen scene and readable hierarchy on resize. Reflow or scroll the navigation as needed and adjust layout or framing so nothing covers the subject.
- Respect reduced-motion preferences for nonessential UI motion.
- Inspect the page over the actual rendered scene at the overview, selected close-ups, and a narrow viewport, following [the validation guide](validation.md).

Browser-default buttons, a lone debug panel, placeholder copy, an unrelated generic HUD, inert buttons, text covering the hero subject, and color-only reskins do not meet this guide. Keep technical implementation details out of the visitor-facing page unless they are needed to operate the experience.
