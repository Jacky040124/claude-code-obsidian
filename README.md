# Claude Code for Obsidian

An Obsidian plugin that integrates [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a local AI runtime. Chat with Claude in a sidebar, search your vault, edit notes, and run quick actions -- all powered by a real agentic process running on your machine.

## Features

- **Sidebar Chat** -- Conversational AI with streaming responses, extended thinking, and tool use visualization.
- **Vault Search** -- Claude can autonomously search your vault by content, tags, frontmatter, links, and recency.
- **Multi-note Context** -- Reference notes with `@filename.md` in chat to include their content as context.
- **Graph Context** -- Optionally inject outgoing links and backlinks of the active note into every prompt.
- **Quick Actions** -- Right-click selected text to summarize, rewrite, fix grammar, translate, or explain.
- **Note Editing** -- Claude can create, edit, and overwrite notes and canvas files via MCP tools.
- **Session Persistence** -- Conversations are saved and resumable across plugin reloads.
- **Model Selection** -- Switch between Haiku, Sonnet, and Opus from the chat panel.
- **Slash Commands** -- Discovers and runs skills from `~/.claude/skills/`.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) must be installed and available in your PATH (or configured in settings).
- Desktop only (macOS, Windows, Linux). Mobile is not supported.

## Installation

1. Open **Settings > Community plugins** in Obsidian.
2. Search for **Claude Code**.
3. Click **Install**, then **Enable**.
4. Ensure the Claude Code CLI is installed: `npm install -g @anthropic-ai/claude-code`

## Usage

1. Click the chat icon in the ribbon (or run "Open Claude Code Chat" from the command palette).
2. Type a message and press Enter. Claude streams its response in real time.
3. Use `@note.md` to reference specific notes in your message.
4. Select text in the editor, right-click, and choose a quick action (Summarize, Rewrite, etc.).

## Network and Privacy Disclosure

This plugin spawns the Claude Code CLI as a local subprocess. All communication with Anthropic's API is handled by the CLI using your own API credentials. The plugin itself makes **no network requests** -- it communicates with the CLI via stdin/stdout and with its own MCP server via localhost HTTP.

- **No telemetry** is collected.
- **No data** is sent to any server other than Anthropic's API (via the CLI).
- File conversions and vault operations happen entirely on your local machine.

## Settings

| Setting | Description |
|---------|-------------|
| Claude model | Haiku, Sonnet, or Opus |
| Binary path | Path to the `claude` CLI binary |
| Allowed tools | Toggle Read, Bash, Glob, Grep, WebSearch, WebFetch |
| Auto-authorize | Skip tool use confirmation |
| Session persistence | Keep sessions across reloads |
| Response timeout | Max seconds per request |
| System prompt | Custom instructions appended to every request |
| Max @ reference chars | Truncation limit per referenced note |
| Graph context | Toggle + configure linked note injection |
| Quick actions | Enable/disable individual right-click actions |

## License

[MIT](LICENSE)
