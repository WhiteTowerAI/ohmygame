# Setup and recovery

OhMyGame's plugin connection panel prepares the pinned CLI and private Python/Lua diagnostics, then connects the account through Maker's browser authorization. Credentials stay with the official CLI. Do not request tokens in chat.

Project binding belongs to the local directory. New game creation includes an inline setup step: create and connect a new Maker project, select an existing project explicitly, or import an already bound directory. Preserve existing bindings, Git history, and dev-kit resources. Create remote projects only when requested. When initialization fails after creation, resume the saved project identity; do not create another project. An unknown creation outcome requires checking the project list before reconnecting.

Do not run standalone editor installers or CLI upgrade commands. The plugin owns its MCP registration and pinned runtime. Upstream `init --skip-mcp-install` can still modify other editors when diagnostics are absent; the connection adapter verifies private diagnostics before initializing.

For development failures, use project MCP status and the returned diagnostics. Distinguish missing environment, expired account access, invalid binding, compilation errors, and Git conflicts. Inspect partial results before retrying operations with side effects.

References: [Maker CLI/MCP](https://github.com/taptap/instant-games-open-mcp/blob/main/docs/MAKER.md), [local preview](https://github.com/taptap/instant-games-open-mcp/blob/main/docs/MAKER_LOCAL_PREVIEW.md).
