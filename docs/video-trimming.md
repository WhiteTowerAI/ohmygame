# Video trimming

Any video in the Library or on an Asset Canvas can be trimmed where it is
previewed. Click a video in **Library**, or double-click a video node on an
Asset Canvas, to open its preview. Instead of the browser's own controls, the
preview shows:

- the video, which plays and pauses when clicked;
- a play button and a track with frames from across the video, to scrub;
- a frame around the part to keep, with a handle at each end. Dragging a
  handle shows the frame under it. Arrow keys move a focused handle by a
  second, or by a tenth with Shift. Space plays and pauses.

While part of the video is left out, the footer shows the kept range and its
length, **Reset** keeps the whole video again, and Play shows only the kept
part. **Save as new video** encodes that part as a new Library video named
after the original, such as `opening (trimmed).mp4`. Saving shows its
progress and can be cancelled. The original stays as it is, and so does
everything that uses it.

- In the Library, the preview switches to the new video. Its details name the
  video it was trimmed from.
- On an Asset Canvas, the new video is added as an asset node beside the node
  it came from, and the preview closes.

A Scene uses a trimmed video like any other video, for example through
**Media → As background** in its Workbench.

## How a trim is encoded

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
- The result is uploaded through `POST /library/assets/upload` like any
  other file, with the 200 MB upload limit.

## Library record

A trimmed video's Library record has `derivedFrom`: the original's Library
asset ID and the kept range in seconds from the start of the original file.

```json
{ "derivedFrom": { "assetId": "…", "trim": { "start": 2.2, "end": 5.4 } } }
```

The upload endpoint sets it from the `trimSource`, `trimStart`, and `trimEnd`
query parameters. All three come together, for a video upload, and the
source must be an existing Library asset; anything else is rejected with
`Invalid trim source`. A video trimmed from an Asset Canvas file that is not
in the Library has no `derivedFrom`. Records without it are read as before.
