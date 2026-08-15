# Publish v1

Publish v1 is the protocol between an OpenGame creator client and a public
publishing service. It is shared by the official service and self-hosted
implementations.

The protocol accepts static build output, not a project workspace, source
repository, Pi session, conversation, or provider key. Artifacts containing
environment files or other private project files are rejected.

## Resources

```text
Publisher 1 --- N Game 1 --- N Deployment
                       1 --- 1 CommunityListing
```

- A `Publisher` owns games. Beta access provisions one publisher token out of
  band; the service stores only its hash.
- A `Game` is the stable published work. Its play URL follows the deployment
  selected by `currentDeploymentId`.
- A `Deployment` is one successful immutable upload.
- A `CommunityListing` is created as `unlisted` with its game and controls
  discovery only. Unlisting a game does not take its play URL offline.

The TypeScript resources, request bodies, and errors live in
`src/shared/publish-v1.ts`.

## Authentication and idempotency

Creator routes require:

```http
Authorization: Bearer <publisher-token>
```

The token identifies one publisher and may own multiple games. It must stay in
the daemon's private application state, never in a project workspace or a
published artifact.

`POST /v1/games` and `POST /v1/games/:gameId/deployments` also require an
`Idempotency-Key`. Keys are scoped to publisher, method, and route. Reusing a
key with the same payload returns the original result; reusing it with another
payload returns `409 idempotency_conflict`.

Every response includes an `X-Request-Id`. Error responses use the
`PublishApiError` shape and never expose stack traces or provider responses.

## Creator API

```text
POST  /v1/games
GET   /v1/games/:gameId
POST  /v1/games/:gameId/deployments
PUT   /v1/games/:gameId/listing
```

The JSON bodies and successful responses are:

| Route | Request | Response |
| --- | --- | --- |
| `POST /v1/games` | `CreatePublishGameRequest` | `201 PublishGame` |
| `GET /v1/games/:gameId` | none | `200 PublishGame` |
| `POST /v1/games/:gameId/deployments` | multipart described below | `201 CreatePublishDeploymentResult` |
| `PUT /v1/games/:gameId/listing` | `SetPublishListingRequest` | `200 PublishCommunityListing` |

Creator reads are authenticated and ownership-scoped. A game owned by another
publisher returns `404 not_found`, rather than revealing that it exists.

`POST /v1/games/:gameId/deployments` uses `multipart/form-data` with two parts:

- `metadata`: JSON matching `CreatePublishDeploymentMetadata`.
- `artifact`: an `application/zip` body whose expanded root contains
  `index.html`.

The client supplies the ZIP byte length and lowercase SHA-256 digest. The
service recomputes both. The creator excludes hidden files and dependencies.
The service independently validates configured compressed, expanded,
single-file, and file-count limits; rejects absolute paths, `..` traversal,
symbolic links, duplicate paths, hidden path segments such as `.env` and `.git`,
and `node_modules`; and never executes files from the upload.

The service completes each deployment during the upload request. Activation is
atomic:

1. Validate and install the archive under a new immutable ID.
2. Store the Deployment and replace `Game.currentDeploymentId` in one committed
   database transaction.

If either step fails, temporary files are removed and the prior current
Deployment remains live.

## Community API

```text
GET /v1/community/games
GET /v1/community/games/:gameId
```

These routes are public and return listed games. Community responses do not
expose publisher tokens, artifact digests, or deployment history.

The creator uses `PUT /v1/games/:gameId/listing` with either `listed` or
`unlisted`. A first publish may call it immediately after activation, but it is
not part of the deployment transaction. A listing failure can therefore be
retried without uploading the artifact again.

## URL contract

The service returns absolute URLs; clients must not construct them. A typical
official deployment uses separate hosts:

```text
Community:          https://opengame.example/games/<game-id>
Stable play URL:    https://g-<game-id>.play.opengame.example/
Immutable version: https://d-<deployment-id>.play.opengame.example/
```

The play domain must not receive Community authentication cookies or publishing
credentials. A version URL always serves the same files. The stable URL changes
only when another Deployment is published.

## Publish flows

First publish:

```text
create Game with unlisted listing -> upload Deployment -> verify and activate -> set listing=listed
```

Publish update:

```text
upload Deployment -> verify and activate -> preserve current listing status
```

Unlist:

```text
set listing=unlisted -> remove from Community -> keep stable play URL live
```

Failed update:

```text
discard failed upload -> keep prior currentDeploymentId and listing
```

Public deletion, rollback, custom domains, moderation history, social features,
and source-code remixing are outside Publish v1.

## Reference server

The repository includes a minimal reference server under `src/publish-server`.
It uses Node's built-in SQLite and a local artifact directory; it does not use
an ORM, object storage, queue, or Pi. Start it with `npm run dev:publish` after
setting `PUBLISH_TOKEN` in `.env.local`. Its default data directory is
`.data/publish` and its default API and play port is `43130`.

## Minimal production deployment

The reference deployment keeps the Community Web and Publish service separate:

```text
community.example.com  -> Vercel
publish.example.com    -> Railway
*.play.example.com     -> Railway
```

Railway builds the Node runtime with `railway.toml`. Attach a persistent volume
at `/data`, then configure:

```dotenv
PUBLISH_TOKEN=<secret>
PUBLISHER_ID=local-publisher
PUBLISH_DATA_DIR=/data
PUBLISH_PLAY_ORIGIN=https://play.example.com
```

Railway supplies `PORT`; the server listens on `0.0.0.0` when it is present.
Add both `publish.example.com` and `*.play.example.com` to the same Railway
service. Stable game URLs use `g-<gameId>.play.example.com`, while immutable
deployment URLs use `d-<deploymentId>.play.example.com`.

Vercel builds the Community app with `vercel.json`. Set its build-time variable
to the public Railway API origin:

```dotenv
VITE_PUBLISH_API_URL=https://publish.example.com
```

Only the public `GET /v1/community/*` routes allow cross-origin browser reads.
Creator routes remain token-authenticated and do not expose CORS headers.
