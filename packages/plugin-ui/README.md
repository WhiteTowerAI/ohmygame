# @ohmygame/plugin-ui

Styles, the host bridge and page components for
[OhMyGame](https://github.com/WhiteTowerAI/ohmygame) plugin pages.

The app serves these files to every plugin page, so a page loads them from the
app rather than from this package:

```html
<link rel="stylesheet" href="/_ohmygame/plugin-ui.css" />
<script type="module" src="/_ohmygame/ui/1/index.js"></script>
<script type="module" src="./main.js"></script>
```

```js
import { connect } from "/_ohmygame/plugin-ui.js";

const host = await connect();
const project = await host.request("project.info");
```

Pages allow no inline scripts and no other sites' scripts, so a page's own
script is a file beside it.

The shared stylesheet reserves space for traditional page scrollbars with
`scrollbar-gutter: stable`; tabs and disclosures can change height without
shifting the page horizontally. Dialog content does the same within its own
scroll area. Overlay scrollbars keep the platform's normal behavior. A plugin
with its own scroll container should apply this property to that container;
avoid `100vw` for content width or JavaScript scrollbar-width compensation.

Install the package for its types and for editor support:

- `@ohmygame/plugin-ui` types the bridge, for example
  `/** @type {import("@ohmygame/plugin-ui").PluginUiHost} */`.
- `@ohmygame/plugin-ui/ui/1` types the page components and their attributes.
- `ui/1/custom-elements.json` is a Custom Elements Manifest, which editors
  read for completions.

The package's version is the plugin API it matches.
