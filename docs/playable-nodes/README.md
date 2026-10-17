# Playable Nodes

## Status

Playable Nodes is the runtime and editor model used for Interactive Stories.
This directory documents its architecture, authoring experience, and agent
contract.

## The idea in one paragraph

A Playable Nodes project is a graph of free, programmable screens. Every node
is the same kind of thing: images, video, and audio combined with web code
into whatever presentation that screen needs, whether a main menu, a
case archive you can page through, a dialogue, a puzzle, or a small game.
Nodes are connected by explicit logic: a node reports what happened, and the
graph decides where the player goes next. Authors create nodes mainly by
describing them to the Agent, not by choosing a node type or writing code.

## Core boundaries

- **Nodes own presentation and input. The Runtime owns state and flow.**
  Inside a node, anything a browser can do is allowed. Between nodes, state,
  navigation, saving, and assets go through the Runtime.
- **One node type.** Menu, scene, choice, archive, and ending are starting
  points (presets), not runtime categories.
- **Presets are copied once, then belong to the project.** A preset's files,
  and the shared files it brings such as the Project Style or the Visual
  Novel player, are written when the project first needs them. From then on
  they are the author's: OhMyGame never updates or replaces them, and later
  preset changes reach only nodes created afterwards. Only the Runtime in
  `story/` is updated by OhMyGame, keeping files the author changed (see
  [runtime.md](runtime.md#the-story-runtime-in-the-project)).
- **Genres are presets, not systems.** A visual novel chapter, a film shot,
  a phone the player looks through, and a puzzle are all nodes. They connect
  by Signals like any other nodes, and they share the Runtime's State, save,
  slots, music, and preferences. A genre needs a preset and the Agent; it
  does not need a Runtime feature or an editor panel of its own.
- **Agent first.** Authors describe, the Agent builds, the author sees the
  result live. Editing code by hand is a rarely used escape hatch.
- **Asset Canvas stays separate.** Asset Canvas creates media; Playable Nodes
  turns media into a playable project. They meet through the shared Asset
  Library and stable Asset IDs.

## Vocabulary

| Name             | Meaning                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| Playable Node    | One screen the player sees and operates; media plus code                     |
| Node Graph       | The saved graph of nodes and the edges between them                          |
| Signal           | A named outcome a node reports, such as `open-archive`                       |
| Edge             | A connection from one node's Signal to another node                          |
| Navigation Exit  | A Signal with `role: navigation`, such as Home; named on the canvas, no line |
| Project State    | Serializable data shared across nodes and included in saves                  |
| Variable         | One top-level Project State key, with an optional description in `variables` |
| Exit condition   | A Signal's `when`: a one-line description of when it is taken; display only  |
| Shared component | UI in `shared/components/` that several nodes import; its Signals are theirs |
| Project Style    | Shared theme and components that keep every node visually consistent         |
| Preset           | Starter content and instructions for a new node; no runtime meaning          |
| Node Runtime     | Hosts nodes and owns state, navigation, back stack, saves, and assets        |

The editor shows authors plainer words for the same things. Code, schemas,
tools, and the other documents keep the engine terms; `authoring.md` uses the
editor's words.

| Editor                   | Engine term                                    |
| ------------------------ | ---------------------------------------------- |
| Scene                    | Node                                           |
| Exit                     | A Signal and the edge that routes it           |
| Exit with **Allow Back** | A `push` edge                                  |
| Start                    | Entry Node (`entryNodeId`)                     |
| Template                 | Preset                                         |
| Replay                   | Restart                                        |
| Select                   | Pick element                                   |
| History                  | Back stack                                     |

## Documents

| Document                     | Question it answers                                  | Status         |
| ---------------------------- | ---------------------------------------------------- | -------------- |
| [vision.md](vision.md)       | Why the fixed node-type model was redesigned         | Design history |
| [authoring.md](authoring.md) | What creating a project feels like in the editor     | Current        |
| [runtime.md](runtime.md)     | The Node protocol, State, Signals, navigation, saves | Current        |
| [agent.md](agent.md)         | What the Agent is given, its rules, and its tools    | Current        |

Start with `runtime.md` for implementation, `authoring.md` for editor behavior,
or `agent.md` for agent integration. Read `vision.md` for the redesign's rationale;
its description of the former editor is historical.
