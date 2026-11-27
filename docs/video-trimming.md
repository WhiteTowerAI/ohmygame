# Video trimming

Any video in a project's Assets or on an Asset Canvas can be trimmed. In
**Assets**, open a video; its preview is the trimmer. On an Asset Canvas,
double-click a video node; its preview is the trimmer. Instead of the browser's own controls, the trimmer
shows:

- the video, which plays and pauses when clicked;
- a play button and a track with frames from across the video, to scrub;
- a frame around the part to keep, with a handle at each end. Dragging a
  handle shows the frame under it. Arrow keys move a focused handle by a
  second, or by a tenth with Shift. Space plays and pauses.

While part of the video is left out, the footer shows the kept range and its
length, **Reset** keeps the whole video again, and Play shows only the kept
part. **Save as new video** encodes that part as a new video named after the
original, such as `opening (trimmed).mp4`, in the same project. Saving shows its
progress and can be cancelled. The original stays as it is, and so does
everything that uses it.

- In Assets, the new video opens in place of the original.
- On an Asset Canvas, the new video is added as an asset node beside the node
  it came from, and the preview closes.

## How a trim is encoded

The preview and yellow-handle timeline live in the controlled
`src/renderer/video-trim-editor.tsx` component. It only edits a range and
previews it; it never encodes, uploads, or writes project files.
`useVideoTrimSave` in `src/renderer/video-trimmer.tsx` holds the encode and
save; `VideoTrimmer` pairs it with the editor for the Assets and Asset Canvas
previews. Other
editing flows can reuse the same controls and `.video-trimmer-*` styles
without inheriting the encode/upload action.

Space on the timeline or either handle toggles playback once. Failed video
loading disables playback/saving and shows a translated error. Encoding can
be cancelled; once uploading starts, Cancel is disabled because the upload
cannot be cancelled by the encoder's abort signal.

Trimming runs in the renderer with [Mediabunny](https://mediabunny.dev)
(MPL-2.0) and the browser's WebCodecs encoders, so no media tools are
installed. `src/renderer/video-trim.ts` loads Mediabunny only when a trim
is saved or its frames are read.

- The cut is exact: video and audio are re-encoded from the start of the
  trim, not copied from the nearest keyframe.
- WebM stays WebM. MP4, QuickTime, and anything else become MP4, using the
  first codec the encoders support, normally H.264 and AAC.
- The video is encoded at the source's average bitrate, kept between 1 and
  20 Mbit/s, so a trimmed file is not much larger per second than the
  original.
- The result is uploaded like any other file, with the 200 MB upload limit:
  from Assets through `POST /projects/:id/media`, and on an Asset Canvas
  through `POST /projects/:id/canvas/assets`, which also names it on the
  canvas.
