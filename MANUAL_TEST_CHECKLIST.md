# Manual Test Checklist — Obsidian Claude Code Plugin

## Prerequisites
- [ ] Claude Code CLI installed (`claude --version` works)
- [ ] Obsidian desktop app installed
- [ ] Plugin built (`npm run build` produces `main.js`)

## Installation
- [ ] Copy `main.js`, `manifest.json` to vault's `.obsidian/plugins/obsidian-claude-code/`
- [ ] Enable the plugin in Obsidian Settings → Community Plugins
- [ ] Plugin loads without console errors

## Settings Tab
- [ ] Settings tab appears under "Claude Code" in Obsidian Settings
- [ ] Binary path field shows "claude" by default
- [ ] "Verify" button detects installed CLI and shows version
- [ ] "Verify" button shows error when binary path is invalid
- [ ] Tool toggles enable/disable individual tools
- [ ] Auto-authorize toggle works
- [ ] Session persistence toggle works
- [ ] Response timeout field accepts valid numbers, rejects non-numeric

## Chat Sidebar
- [ ] Ribbon icon (message-square) appears in left sidebar
- [ ] Clicking ribbon icon opens chat panel in right sidebar
- [ ] Command palette: "Open Claude Code Chat" works
- [ ] Chat input field is visible with placeholder text
- [ ] Send button is present

## Sending Messages
- [ ] Type a message and press Enter — message appears in chat
- [ ] Assistant response streams in (text appears incrementally)
- [ ] Streaming indicator (dots) shows while waiting
- [ ] Send button is disabled during streaming
- [ ] Shift+Enter creates newline in input (does not send)
- [ ] Command history: Arrow Up/Down cycles through previous messages

## File References
- [ ] Typing `@` shows autocomplete dropdown with vault files
- [ ] Autocomplete filters as you type after `@`
- [ ] Selecting a file inserts `@path/to/file.md` into input
- [ ] Arrow keys navigate autocomplete, Enter selects
- [ ] Escape closes autocomplete

## Tool Use
- [ ] Tool use indicators show (e.g., "Read", "Edit") during operations
- [ ] Running state shows loader icon
- [ ] Completed state shows check icon
- [ ] Error state shows alert icon

## File Sync
- [ ] When Claude edits a vault file, the change appears in Obsidian
- [ ] When Claude creates a new file, it appears in the file explorer
- [ ] Notification shows "Modified: filename" after edits
- [ ] Files outside vault are not synced (no errors)

## Session Management
- [ ] "New Chat Session" command clears messages and starts fresh
- [ ] Subsequent messages in same session maintain context
- [ ] Session persists across chat panel close/reopen (if enabled)

## Error Handling
- [ ] Graceful error message if Claude CLI is not installed
- [ ] Graceful error message if CLI times out
- [ ] Error appears in chat bubble, not just console
- [ ] Plugin unload cleans up running processes

## Edge Cases
- [ ] Sending empty message does nothing
- [ ] Very long messages are handled
- [ ] Rapid successive messages don't corrupt state
- [ ] Closing chat panel during streaming cancels gracefully
