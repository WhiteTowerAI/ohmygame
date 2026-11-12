# Compatibility

What OhMyGame keeps working across versions, where that code goes, and when
it is removed. The audit behind these rules is
[#717](https://github.com/WhiteTowerAI/ohmygame/issues/717).

## What needs compatibility

| Kind | Examples | Rule |
| --- | --- | --- |
| Internal code | Functions, modules, HTTP routes between the renderer and its own daemon | None. Change every caller in the same PR; leave no wrapper for the old shape. |
| Stored data | Settings in the data directory, project files such as `.ohmygame/assets.json` and `canvas/`, conversations, browser storage, project archives | Migrate it when it loads, as below. |
| Contracts with others | Plugin API and manifest, page components, the page bridge, the project archive format | Semantic versions: add without breaking, mark what goes as deprecated, remove it only in a new major version. See [plugins](plugins.md). |

## Stored data

- **A version for each store.** Every file or record OhMyGame writes carries
  a `version`.
- **Migrate once, where it loads.** Loading runs each step from the stored
  version to the current one, `1 → 2 → 3`, and writes the result back. Code
  after loading sees only the current shape; nothing elsewhere checks for an
  old one. Keep the steps next to the store that owns the format.
- **Never replace what it can't read.** A file from a newer version, or one
  that is damaged, is left as it is. Refuse the change and say why, or skip
  it when the work around it must go on, but never write an empty or partial
  store over it.
- **Test each step** with a fixture of the old data.
- **Avoid needing it.** Store a key next to text that may be reworded, and
  don't offer an agent or plugin a parameter only kept for old data.

Reading old data without writing it back is a last resort, for data that
can't be rewritten: a conversation's history, an archive on someone's disk,
another program's files.

## When it goes

Mark every piece of compatibility code where it starts:

```ts
// compat: since beta.4.8, remove from beta.6 and 2026-11-13. Pi 1.0.3 renamed the Azure provider.
```

`since` is the first release that shipped it. `remove from` names a release
series **two series later** (`beta.4.x` → `beta.6`) and a date **30 days**
after `since` shipped; the code may go once both have passed. Updating from
any release in that window keeps working. When a migration goes, data it
would have handled should get a clear message, not be misread. Find what is
due with `git grep -n "compat:"`.

Two cases have their own condition instead of a release:

- **Another program's versions,** such as a coding agent CLI: remove when the
  oldest version OhMyGame supports no longer needs it, and say which.
- **Project archives:** importing keeps every archive format until a major
  version, since archives live outside the app.
