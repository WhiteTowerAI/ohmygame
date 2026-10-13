# Provider logos

Register every provider logo in `src/renderer/provider-icons.ts` and render it
through the shared `ProviderMark` component. Cloud and personal connections to
the same provider should reuse the same icon.

- Prefer an official SVG, including those available in `@lobehub/icons-static-svg`.
- When only a raster logo is available, keep a local transparent PNG. Avoid
  tracing a small image into an approximate SVG or wrapping its base64 in SVG.
- Import assets as files and let Vite handle their URLs and any build-time
  inlining. Do not put base64 strings directly in components or the registry.
- Use `color` for colored artwork and `monochrome` for black artwork on a
  transparent background. The shared CSS handles size, background and contrast.

`hyper3d.png` is the supplied 64 × 64 Hyper3D logo. Its white pixels were
normalized to black to match the monochrome convention; the original alpha
channel and silhouette are unchanged. It is sufficient for the current 20px
display, including at 2× and 3× pixel density. Replace it with an official
vector file if one becomes available.
