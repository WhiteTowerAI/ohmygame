# Project archives

A project archive is a ZIP file that moves one project to another computer or
keeps a copy outside OhMyGame's data folder. **Export project** in a project
card's menu saves one for any project type. Story settings → **Export project**
uses the same archive format and export service, after saving the editor's changes.
**Import project** on the Projects page creates a new project from it. You can
also drag one ZIP archive onto the Projects page. Both entry points use the
same import checks. Import one archive at a time.

Start with `src/daemon/project-archive.ts`, `src/shared/project-archive.ts`
and `src/renderer/project-card.tsx`. The focused suites are
`test/project-archive.test.ts`, `test/project-archive-assets.test.ts` and
`test/project-archive-ui.test.tsx`.

## Layout

| Entry                   | Contents                                                               |
| ----------------------- | ---------------------------------------------------------------------- |
| `ohmygame-project.json` | The manifest: format, version, project settings and cover mode.        |
| `workspace/`            | The project's workspace files.                                         |
| `cover.webp`            | The project's stored cover, when it has one. A story thumbnail is not. |

The manifest looks like this:

```json
{
  "format": "ohmygame-project",
  "version": 1,
  "project": {
    "name": "Moon Garden",
    "type": "general",
    "webPreviewEnabled": true,
    "mediaModelDefaults": {
      "image": { "provider": "openai", "id": "gpt-image-1" }
    }
  },
  "cover": { "mode": "custom" }
}
```

`project` holds the name, type, plugin integration, preview and run settings,
and media model defaults: the keys listed in `PROJECT_ARCHIVE_SETTING_KEYS`.
A key is present only when the project sets it. `cover.mode` says whether the
cover was chosen by hand (`custom`) or captured automatically (`auto`).

## What an export leaves out

- Dependencies and version control wherever they are: `node_modules` and
  `.git`.
- Build output and caches at the workspace root: `dist`, `build`, `out` and
  `.godot`. A game's own `levels/build/` stays.
- Agent data and the Canvas job queue at the workspace root: `.ohmygame`,
  `.data/agent-attachments` and `canvas/jobs.json`.
- Environment files wherever they are: every name starting with `.env`.
- Symbolic links.
- Conversations, checkpoints and publish information, which live outside the
  workspace and hold absolute paths or belong to an account.

The rest of `.data/`, such as `.data/assets.json` and `.data/asset-previews`,
is kept so asset prompts and previews travel with the assets. `.gitignore`
files do not change what is exported.

An Interactive Story's graph can point at Library assets outside the
workspace. Each one is copied to `workspace/assets/library/` and `graph.json`
points at the copy. Export fails
with the asset's name when one is missing from the Library, and while the
project's agent is working. It also fails, before anything is downloaded, when
the archive would exceed the import limits described below.

Export counts every file's extracted contents, including the manifest and the
rewritten story graph. It then writes the ZIP to a temporary file while counting
its actual bytes, including ZIP headers and compression overhead. Both size
checks finish before a download starts. The completed file streams to the
response and is removed after the download finishes or is cancelled. Export
requires temporary disk space for the ZIP; it does not hold the archive in memory.
The desktop app and browser still collect the download before saving it.

## Import

`POST /projects/import` takes the archive as the request body with the
content type `application/vnd.ohmygame.project-archive`. The upload streams to
a staging folder next to the projects, so large archives are not held in
memory. Import then works like **Duplicate**:

- the project gets a new id and is stored in OhMyGame's data folder;
- publish information is never imported;
- Canvas generation history in `canvas/jobs.json` is bound to the new id;
- an Interactive Story gets the current agent instructions and schemas;
- the cover is restored with its mode;
- preview readiness is checked again.

Settings pass the same checks as saved project settings. An archive from a
newer format version asks for an OhMyGame update. If any step fails, nothing
of the import remains; a staging folder left by a crash is removed on the next
start.

Extraction rejects paths with `..` segments, absolute paths, drive letters
and symbolic links, and creates every file exclusively. An archive
may hold up to 200,000 entries and 10 GB, counted for the upload and for the
extracted files. Version control, dependencies and agent data inside an
archive are skipped. Other files, such as a hand-made archive's `canvas/jobs.json`
or `.env`, are imported as they are.

### Interactive Story project files

Earlier versions export only Interactive Stories, from Story settings →
**Export project**. Those ZIP files have no manifest and hold `graph.json` at
their root. They import as an Interactive Story named after the file; the
renderer passes the name as `?name=`.
