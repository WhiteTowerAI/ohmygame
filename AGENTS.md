# Repository instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification, formatting, and
the contribution workflow. [docs/README.md](docs/README.md) maps modules to
their code, documentation, and tests.

## Git

- Keep PRs focused on one feature, bug fix, documentation change, chore, or refactor.
- Start contribution branches from `dev` and target ordinary PRs at `dev`.
  `main` receives maintainer release PRs from `dev`.
- Use `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`,
  `refactor/<short-name>`, or `docs/<short-name>` for contribution branches.
- Use Conventional Commit PR titles, for example
  `feat(editor): add marquee selection`, `fix(runtime): handle missing tween state`,
  or `docs(agents): update collaboration rules`.
- PR descriptions must say what changed, why it changed, and how it was checked.

## Changes and verification

- Match existing style and keep unrelated formatting cleanup in a separate PR.
- Update relevant documentation when public behavior or file contracts change.
- `README.md` is the source for `README.zh-CN.md`. Update both in the same PR,
  keeping sections, media, and links aligned; say so in the PR if the
  translation must follow later.
- Use the [checks guidance](CONTRIBUTING.md#make-and-check-your-change) for the
  change type. Record skipped checks and manual validation still needed.
