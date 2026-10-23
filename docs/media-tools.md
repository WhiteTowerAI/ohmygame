# Media processing tools

The image-node toolbar shows three menus: **Image tools** (AI cutout and crop),
**Grid split**, and **GIF & merging** (GIF extraction, GIF/video composition, and
layer composition). The shared catalog is `src/shared/media-tools.ts`.
Frame sorting, stitching, resize, outline, polygon cutout, brush retouch, and
color-key removal are available through the existing independent agent/API
functions, rather than the toolbar.

AI cutout runs the Apache-2.0 [U²-Net](https://github.com/xuebinqin/U-2-Net)
small segmentation model locally through ONNX Runtime. On first use, the daemon
downloads the pinned 4.5 MB `u2netp.onnx` model, verifies its SHA-256, and caches it
in the application's `media-models/` data directory. Later runs work offline;
no image is uploaded to a provider. The output is a transparent PNG at the
oriented source dimensions, preserving any existing transparency. Failed
downloads can be retried. Processing lives in `src/daemon/ai-cutout.ts`.

Crop enters selection mode directly on the original canvas image. Drag the
selection or its eight handles, optionally choose an aspect ratio, and confirm
to create a new cropped node. Cancel or Escape exits selection mode. Switching
nodes also exits. Coordinates are mapped to source pixels, including during
pan and zoom. Grid split has 4/9/16/25-cell presets and an **Other** cell picker;
the preview dialog allows custom rows and columns before execution.

The agent exposes these additional processing functions:

| Group | Agent tools | Behavior |
| --- | --- | --- |
| Background removal | `remove_green_screen`, `remove_blue_screen`, `remove_white_background` | Remove the selected background color with adjustable tolerance; PNG or WebP preserves transparency. |
| Quick and detailed processing | `resize_image`, `outline_image`, `crop_image`, `cutout_image`, `brush_retouch_image` | Resize, colored outline, rectangular crop, polygon cutout, and brush-controlled softening. |
| GIF, frame order and merging | `extract_gif_frames`, `compose_gif`, `sort_frames`, `stitch_images` | GIF to numbered PNG frames, ordered frames to GIF, explicit frame ordering, and horizontal/vertical stitching. |

The old aggregate `image_edit` and `image_transform` tools and Canvas operations
have been removed. Grid splitting (`image_grid_split`) and video operations
(`video_extract_frames`, `video_frame_strip`, `video_compose_frames`) remain
separate tools. Agent grid/video extraction returns a ZIP and manifest;
GIF extraction and frame ordering save individually numbered image assets.

Single-image Canvas operations use the first selected image. GIF/video
composition accepts the complete selection and provides thumbnail controls
to move each input earlier or later before execution.
Frame sorting exports numbered PNG assets in the chosen order; it does not
sort by filename or create an animation. GIF/video composition uses the chosen
order directly, so frame sorting is optional when the goal is only a GIF or
video. The agent supplies ordered `framePaths` for these operations.

Agent polygon cutout retains the region defined by `points`. Brush retouch
applies local blur under `strokes` (arrays of points), with a source-pixel
`radius` and optional `strength`; it does not perform AI inpainting. Outline
adds transparent padding equal to its thickness on every side so opaque
images and edge-touching subjects receive a visible outer border.

The implementations live in `src/daemon/media-tools.ts`; the agent-facing
wrappers live in `src/daemon/agent-tools.ts`. Image work uses Sharp/libvips,
and video work invokes `ffmpeg` with argument arrays (without a shell). Input
paths are resolved through the current project workspace, so paths outside the
workspace and symlinks are rejected.

Asset Canvas also provides deterministic layer composition. Select at least
two image nodes, then set the output canvas size and each layer's position,
scale, opacity, visibility, and stacking order. The preview supports dragging
layers; the daemon clips them to the output bounds and writes a transparent PNG
as a new canvas asset. No image-generation model is called.

Video tools use the platform FFmpeg binary installed with the project. Set
`OHMYGAME_FFMPEG_PATH` to use a different binary; if the platform package is
unavailable, the daemon falls back to `ffmpeg` on `PATH`. Extracted videos are limited to 300
seconds and 1,000 frames. Grid splitting preserves every source pixel even
when dimensions are not evenly divisible; edge cells can differ by one pixel.
Video composition uses the first frame's displayed dimensions and fits every
other frame inside that canvas with transparent padding, so mixed-size frames
do not fail or lose content. MP4 dimensions are rounded up to even pixels for
the H.264 encoder.
Composition writes temporary input frames numbered from 1, avoiding the
`-start_number` option that some FFmpeg builds do not recognize.

When both resize dimensions are supplied, the output canvas uses those
exact dimensions and preserves the source aspect ratio with transparent
padding; supplying only width preserves the source aspect ratio.

In Asset Canvas, selecting an image shows category buttons 10 screen pixels
from the node. Hovering over or clicking a category opens its menu of individual
tools. Composition requires at least two selected images and is disabled with a
single image. GIF extraction is enabled only for a single GIF asset, verified
again by the daemon; PNG/JPEG/WebP nodes cannot invoke it. Character action templates are not part of this toolbar. Selecting
a video shows a direct frame-strip button. The toolbar
follows selection, dragging, panning, and zooming.
If there is no room above the node, it appears below it. Running a tool creates
new asset nodes beside the source, selects the results, and brings the first
result into view. Grid splits and video frame extraction create one node per
frame, in frame order. Grid split previews its cell boundaries on the image.
On a video node, Pull frame strip previews the video and lets the user choose
which sampled frames to export. The selected frame indices are preserved in
the result names and manifest. If the browser cannot decode the video, the
selected time range can still be extracted without frame selection. Results
are also saved to Library. The dialog shows
processing status and any error, and remains open on failure so the operation
can be retried. Media processing is not subject to the 10-second canvas file
I/O timeout.

## Character image generation

Image generation nodes offer a **Character asset** mode in the prompt input.
When the user generates, `characterAssetPrompt` from
`src/shared/canvas-character-tools.ts` expands the description into a complete
image prompt. The existing image model, reference images, generation history,
and Library output remain in use. The prompt requests one wide, four-panel
character sheet: full-body view, waist-up portrait, nine expressions, and a
front/side/back turnaround with head details. Entering this mode selects the
widest aspect ratio supported by the current model; users can change it before
generating. The panels are generated by the image model, so exact layout and
identity consistency depend on that model.

Selecting one existing image adds **Continuous actions (V4Tx3)** and **All
actions** to the Character actions menu. Each action asks for an action description,
creates an image generation node linked to the selected image, and starts a
reference-image generation job. The prompt is saved in the existing image node
field, so older canvas daemons can save the board. The first mode requests one 4-column by 3-row
sheet of ordered animation frames. The second requests one 3-column by 3-row
sheet of distinct poses. The user can split either sheet with Grid split.
These are local prompt templates for connected image models, not the private
Gemini Gem prompts behind FrameRonin; output consistency depends on the model.
