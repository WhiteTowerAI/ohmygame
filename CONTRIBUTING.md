# Contributing to OhMyGame

Thanks for helping. OhMyGame is in early alpha, so the most useful
contributions right now are bug reports with clear steps, small fixes, and
feedback from making real games with it.

## Before you start

- For a bug, search [existing issues](https://github.com/WhiteTowerAI/ohmygame/issues)
  first, then open one with the bug report template.
- For a new feature or a large change, open an issue to discuss it before
  writing code so implementation and product direction stay aligned.
- Issues labeled `good first issue` or `help wanted` are good places to start.

## Development setup

Requires Node.js 22.19+.

```bash
npm install
npm run dev            # web renderer + local daemon
npm run dev:desktop    # Electron app
```

See the [README](README.md#development) for sign-in, publishing, and proxy
configuration, and [docs/runtime.md](docs/runtime.md) for how the renderer,
daemon, and agent fit together.

## Checks

Run these before opening a PR:

```bash
npm test
npm run typecheck
npm run build
npx prettier --check <changed files>
```

Add or update tests in `test/` when you fix a bug or add behavior.

## Pull requests

- Keep each PR focused on one feature, one bug fix, one chore, or one
  refactor.
- Branch names: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`,
  `refactor/<short-name>`, or `docs/<short-name>`.
- PR titles use Conventional Commits, for example
  `fix(runtime): handle missing tween state`.
- The PR description says what changed, why it changed, and how it was
  checked. The PR template has these sections.
- Include a screenshot or short recording for UI changes.

## Security

Do not report security issues in public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
