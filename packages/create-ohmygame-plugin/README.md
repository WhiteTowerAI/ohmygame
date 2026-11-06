# create-ohmygame-plugin

Makes a new [OhMyGame](https://github.com/WhiteTowerAI/ohmygame) plugin package.

```sh
npm create ohmygame-plugin my-plugin
```

It asks for your npm scope, which becomes the plugin's publisher, and for
what the plugin adds. Pass options after `--` to skip the questions:

```sh
npm create ohmygame-plugin my-plugin -- --publisher you --parts skills,panel --yes
```

| Part | Adds |
| --- | --- |
| `skills` | A Skill for the agent |
| `panel` | A panel and a command that opens it |
| `native` | Native code with a tool for the agent and a command |
| `mcp` | A local MCP server |
| `projectType` | A project type with a template |

The folder is an npm package named `@you/my-plugin`, with both UI languages, a
README and a GitHub Actions workflow that publishes it with provenance. Check
it with `npm run check`, and try it in OhMyGame from **Plugins › Add plugin ›
This computer** with **Develop** on.

The package's version is the plugin API it writes for. A plugin needs an
OhMyGame release with that API or a later minor one.
