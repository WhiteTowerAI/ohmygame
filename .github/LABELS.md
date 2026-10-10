# Issue and PR labels

Issues and PRs share type and area labels. Issues also track their progress and,
when necessary, priority. The repository label definitions are in
[`labels.json`](labels.json).

## Progress

Each open issue has one status label. A typical workflow is:

`triage → backlog → todo → in-progress → closed`

| Label                 | Meaning                                                 |
| --------------------- | ------------------------------------------------------- |
| `status: triage`      | New feedback awaiting evaluation and confirmation.      |
| `status: backlog`     | Accepted work that is not yet scheduled.                |
| `status: todo`        | Planned for the near term, but not yet started.         |
| `status: in-progress` | Implementation, verification, or PR review is underway. |

Maintainers choose when to move an issue forward. Stages can be skipped for urgent
fixes. Move postponed work back to `backlog`. Closing an issue removes its status
labels; use GitHub's close reason and a comment to explain completion or
cancellation. Reopened issues return to `triage`.

For example, an accepted i18n request without a current schedule has
`type: feature`, `area: ui`, and `status: backlog`. Change its status to `todo` when
it enters the near-term plan, then to `in-progress` when work starts.

PRs use GitHub's draft, review, and merge states. They do not need status labels.

## Type

Choose one type for the issue or PR's main purpose.

| Label            | Meaning                                              | PR title prefix |
| ---------------- | ---------------------------------------------------- | --------------- |
| `type: bug`      | Unexpected behavior or its fix.                      | `fix`           |
| `type: feature`  | New functionality or a user experience improvement.  | `feat`          |
| `type: docs`     | Documentation.                                       | `docs`          |
| `type: refactor` | Code restructuring that preserves behavior.          | `refactor`      |
| `type: chore`    | Dependencies, builds, CI, or repository maintenance. | `chore`         |

A feature PR that also updates documentation still has `type: feature`.

## Area

Choose the affected product modules, usually one or two. Pure documentation and
repository maintenance can omit an area when none applies.

| Label           | Scope                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `area: agent`   | Conversations, prompt input, agent execution, context, and tools.        |
| `area: canvas`  | Design and Asset Canvas, documents, nodes, and the Asset Library.        |
| `area: models`  | Providers, model configuration and authentication, and media generation. |
| `area: story`   | Interactive Story editing, scene graphs, state, and navigation.          |
| `area: runtime` | Game execution, previews, playtesting, and project processes.            |
| `area: desktop` | Desktop windows, installation, startup, and updates.                     |
| `area: publish` | Publishing, sharing, and Community integration.                          |
| `area: plugins` | Plugins, Skills, and MCP installation and management.                    |
| `area: ui`      | General interface, project navigation, themes, and internationalization. |

Use the specific module for its interface: a Canvas UI problem belongs to
`area: canvas`; shared appearance or language settings belong to `area: ui`.
Platform, version, and provider details belong in the issue report. Add more area
labels only when enough work warrants a separate category.

## Priority

Maintainers choose at most one priority label.

| Label              | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `priority: urgent` | Immediate attention, such as severe data loss or widespread inability to run. |
| `priority: high`   | Prioritize this work because a core workflow is significantly affected.       |
| No priority label  | Normal ordering after triage.                                                 |

Priority and scheduling are independent. Important work can remain in `backlog`,
and new feedback in `triage` has not necessarily been prioritized yet.

## Additional labels

| Label              | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `good first issue` | A well-defined task suitable for a first-time contributor.      |
| `help wanted`      | Maintainers welcome community contributions.                    |
| `duplicate`        | Link the original issue or PR, then close the duplicate.        |
| `flag: needs-info` | More information or a reproducible example is needed.           |
| `flag: blocked`    | A concrete obstacle prevents progress; explain it in a comment. |

Flags can coexist with a status. For example, started work waiting on an upstream
fix has `status: in-progress` and `flag: blocked`. Remove the flag when resolved.

## Automation

- Bug and feature forms set their type and `status: triage`. Blank issues receive
  `status: triage` when no status is set, and reopened issues return to `triage`.
- Adding a new status, type, or priority label to an issue replaces other labels
  in that group. Closed issues have no status label.
- PR types follow Conventional Commit titles, including updates to the title.
  Unsupported title prefixes leave the type for a maintainer to choose.
- Recognized PR title scopes select the primary area. For other scopes or titles,
  [`labeler.yml`](labeler.yml) adds areas based on specific files. Shared API,
  contract, and stylesheet files do not imply an area on their own. Automated area
  additions preserve manually assigned areas; maintainers can adjust them.
- Progress, priority, and additional labels are maintainer decisions. Opening a
  PR does not automatically accept or schedule a linked issue.

The workflow reads GitHub metadata and the base branch's configuration. It does
not check out or execute code from a PR.
