# Security Policy

## Supported versions

OhMyGame is in early alpha. Security fixes go into the latest release only.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report it privately through
[GitHub security advisories](https://github.com/WhiteTowerAI/ohmygame/security/advisories/new).
<!-- TODO(contact): add a security email as a second channel -->

Include what you found, how to reproduce it, and what an attacker could do
with it. We aim to acknowledge reports within 3 business days and will keep
you updated until it is fixed.

## Scope

In scope:

- The desktop app, the local daemon, and the web renderer in this repository
- How provider keys, sign-in tokens, and project files are handled
- The publish client and what it uploads

The hosted Publish and Community services live in
[`ohmygame-cloud`](https://github.com/WhiteTowerAI/ohmygame-cloud); report
issues there the same way.

The local daemon is designed for a single trusted user on their own machine.
See the trusted-local security boundary in [docs/runtime.md](docs/runtime.md).
