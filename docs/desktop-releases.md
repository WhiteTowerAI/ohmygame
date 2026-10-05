# Desktop releases

OhMyGame uses `electron-updater` with a generic HTTPS update feed. Release
artifacts are built by GitHub Actions and copied to a public, read-only
Cloudflare R2 custom domain, so updates do not depend on GitHub.

## Update feed

Create an R2 bucket and expose the release prefix through a custom domain. The
URL must not require browser cookies or an embedded cloud credential. For
example, with the prefix `desktop`:

```text
https://updates.ohmygame.ai/desktop/latest.yml
https://updates.ohmygame.ai/desktop/latest-mac.yml
https://updates.ohmygame.ai/desktop/OhMyGame-0.1.0-x64.exe
```

The workflow uploads versioned installers and blockmaps with immutable cache
headers. It uploads `latest.yml` and `latest-mac.yml` last with caching disabled,
so clients never observe a manifest before its referenced files exist.

Configure these GitHub Actions repository variables:

| Variable                   | Example                               | Purpose                                             |
| -------------------------- | ------------------------------------- | --------------------------------------------------- |
| `DESKTOP_UPDATE_URL`       | `https://updates.ohmygame.ai/desktop` | Public feed URL embedded in the app                 |
| `R2_ACCOUNT_ID`            | Cloudflare account ID                 | Builds the R2 S3 endpoint                           |
| `R2_BUCKET`                | `ohmygame-releases`                   | Destination bucket                                  |
| `R2_DESKTOP_UPDATE_PREFIX` | `desktop`                             | Destination key prefix, without surrounding slashes |

Configure these repository secrets:

| Secret                        | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `R2_ACCESS_KEY_ID`            | R2 API token access key with object write access |
| `R2_SECRET_ACCESS_KEY`        | R2 API token secret                              |
| `CSC_LINK`                    | Base64-encoded Apple Developer ID certificate    |
| `CSC_KEY_PASSWORD`            | Apple certificate password                       |
| `APPLE_ID`                    | Apple account used for notarization              |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password                      |
| `APPLE_TEAM_ID`               | Apple Developer team ID                          |

The R2 credentials belong only in GitHub Secrets. Do not include GitHub, R2,
or code-signing credentials in the application or the public update bucket.

## Publishing

Set `package.json` to the release version, commit it, and create a matching
`v*` tag. Pushing the tag starts `.github/workflows/release-desktop.yml`, which:

1. Builds the Windows NSIS installer and macOS DMG/ZIP.
2. Builds Windows without code signing and signs/notarizes macOS.
3. Uploads the packages and blockmaps to R2.
4. Publishes the platform manifests and verifies them through the public URL.
5. Creates a GitHub pre-release with the Windows installer and macOS DMG/ZIP.

Re-running the release job updates the existing GitHub release assets. Do not
re-push a published tag just to repair its GitHub Release page.

Windows builds are unsigned, so Windows may show an unknown-publisher or
SmartScreen warning during download and installation. The update manifest still
provides the SHA-512 digest used by `electron-updater` to validate downloads.

For a local package build, export `DESKTOP_UPDATE_URL` before running
`npm run package:mac` or `npm run package:win`. Development builds do not use
the update feed.

## Rollback

Do not overwrite versioned installers. To roll back a bad release, restore the
previous `latest.yml` and `latest-mac.yml` manifests, or publish a newer patch
version containing the reverted code. Existing clients only install versions
newer than their current application version.
