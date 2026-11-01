---
name: taptap-release
description: Prepare and submit a bound TapTap Maker game's TapTap store page with taptap-cli — icon, banners, screenshots, listing text, agreements, Spark version binding, precheck, review, and release time.
---

# TapTap Release

Maker builds the game package; `taptap-cli` (`@taptap/cli`) edits the TapTap store page and submits review. Neither replaces the other, and a Maker build is not a release.

## CLI and account

Check `taptap-cli version` and `taptap-cli auth status`. If the CLI is missing, ask before installing it. Start sign-in with `taptap-cli auth login --no-wait --json` and give the user the returned verification URL; never ask for tokens or passwords.

The CLI ships its own Skills. Read them before acting instead of relying on memory: `taptap-cli skills list`, then `taptap-cli skills read <name>` for the task, plus `--help` and `taptap-cli schema` for exact arguments. Field rules and sizes come from what the CLI returns for this app.

## Maker specifics

- Find the app that holds this project's Maker packages; duplicate empty drafts can exist and only the web console deletes them.
- Bind the intended Spark version. If it is missing, explain that Maker's test QR tool builds and uploads a test version; run it only with explicit user approval, then verify the version in the CLI package list before binding.
- A Maker build can push its own follow-up commit; pull it before editing again.
- Screenshots and gameplay video must be real game captures, never generated images. Icons and banners may be generated; remove watermarks and any text the field rules forbid.
- Upload files with ASCII names; Chinese file names have returned HTTP 500 `ambiguous_outcome`. After any ambiguous outcome, read the resource back before retrying.

## Writes and review

Preview every write and show the user what changes. Sign agreements, fill qualification answers (including AI-generated content), bind a version, and submit review only after the user explicitly approves that step. Pass `--yes` to high-risk writes only after that approval. Run the CLI precheck before submitting, pick any scheduled release time before submitting (the CLI enforces its minimum lead time), and report what is still a draft.
