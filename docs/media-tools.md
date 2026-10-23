# Media processing tools

The image-node toolbar shows three menus: **Image tools** (AI image cutout and crop),
**Grid split**, and **Frame Animation** (GIF extraction and GIF/video composition).
The shared catalog is `src/shared/media-tools.ts`.

AI image cutout creates a new image generation node, uses the selected image as
its reference, fills a background-removal prompt, and starts the configured
image generation model automatically. The result is written back to the new
node through the normal canvas generation job flow.

GIF extraction runs immediately and creates a node for each extracted frame.
Crop enters selection mode directly on the original canvas image. Drag anywhere
on the image to draw a selection, or drag its border and eight handles to move
or resize it. Optionally choose an aspect ratio, then confirm to create a new
cropped node. Cancel, Escape, or switching nodes exits selection mode. Coordinates are mapped to source
pixels, including during pan and zoom. AI cutout and the 4/9/16/25-cell grid
presets execute immediately. Hovering **Other** opens a side picker for custom
rows and columns; choosing a cell runs the split immediately.

The agent exposes these processing functions:

| Group | Agent tools | Behavior |
| --- | --- | --- |
| Image processing | `crop_image`, `image_grid_split` | Rectangular crop and row-major grid splitting. |
| GIF processing | `extract_gif_frames`, `compose_gif` | GIF to numbered PNG frames and ordered frames to GIF. |
| Video processing | `video_frame_strip`, `video_compose_frames` | Extract selected video frames and encode ordered image frames into a video. |

The old aggregate `image_edit` and `image_transform` tools and Canvas operations
have been removed. Agent grid/video extraction returns a ZIP and manifest;
GIF extraction saves individually numbered image assets.

Single-image Canvas operations use the first selected image. GIF/video
composition accepts the complete selection and provides a numbered thumbnail
strip with left/right controls to reorder inputs before execution.
The implementations live in `src/daemon/media-tools.ts`; the agent-facing
wrappers live in `src/daemon/agent-tools.ts`. Image work uses Sharp/libvips,
and video work invokes `ffmpeg` with argument arrays (without a shell). Input
paths are resolved through the current project workspace, so paths outside the
workspace and symlinks are rejected.

The Canvas API supports deterministic layer composition with output dimensions
and per-layer position, scale, opacity, visibility, and stacking order. The daemon
clips layers to the output bounds and writes a transparent PNG as a new canvas
asset. Layer composition is not offered in the image-node toolbar.

Video tools use the platform FFmpeg binary installed with the project. Set
`OHMYGAME_FFMPEG_PATH` to use a different binary; if the platform package is
unavailable, the daemon falls back to `ffmpeg` on `PATH`. Batch operations are
limited to 100 frames and 128 MiB of encoded output; extracted videos are limited
to 300 seconds. The canvas checks
available node capacity before starting a media
operation. Grid splitting preserves every source pixel even
when dimensions are not evenly divisible; edge cells can differ by one pixel.
Video composition uses the first frame's displayed dimensions and fits every
other frame inside that canvas with transparent padding, so mixed-size frames
do not fail or lose content. MP4 dimensions are rounded up to even pixels for
the H.264 encoder.
Composition writes temporary input frames numbered from 1, avoiding the
`-start_number` option that some FFmpeg builds do not recognize.

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
On a video node, Pull frame strip previews the video and exports the full range
by default. Use the compact range selector to choose the full video or a custom
start time and duration, then use the frame mode selector to export every frame
or exact sampled frames. The selected frame indices
are preserved in the result names and manifest. If the browser cannot decode
the video, the selected time range can still be extracted without frame selection. Results
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
