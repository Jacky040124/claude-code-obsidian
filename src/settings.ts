import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";

export interface ClaudeCodeSettings {
	claudeBinaryPath: string;
	model: string;
	allowedTools: string[];
	autoAuthorize: boolean;
	sessionPersistence: boolean;
	maxResponseTimeout: number;
	defaultSystemPrompt: string;
}

export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
	claudeBinaryPath: "claude",
	model: "sonnet",
	allowedTools: ["Read", "Bash", "Glob", "Grep"],
	autoAuthorize: false,
	sessionPersistence: true,
	maxResponseTimeout: 120,
	defaultSystemPrompt: "",
};

const ALL_TOOLS = [
	"Read",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
];

export class ClaudeCodeSettingTab extends PluginSettingTab {
	plugin: Plugin & { settings: ClaudeCodeSettings; saveSettings: () => Promise<void> };

	constructor(
		app: App,
		plugin: Plugin & { settings: ClaudeCodeSettings; saveSettings: () => Promise<void> }
	) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Model Selection ---
		new Setting(containerEl).setName("Model").setHeading();

		new Setting(containerEl)
			.setName("Claude model")
			.setDesc("Select which Claude model to use.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("sonnet", "Sonnet")
					.addOption("opus", "Opus")
					.addOption("haiku", "Haiku")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Claude Binary ---
		new Setting(containerEl).setName("Claude Code CLI").setHeading();

		new Setting(containerEl)
			.setName("Binary path")
			.setDesc("Path to the Claude Code CLI binary. Leave as 'claude' to use the system PATH.")
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudeBinaryPath)
					.onChange(async (value) => {
						this.plugin.settings.claudeBinaryPath = value || "claude";
						await this.plugin.saveSettings();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Verify").onClick(async () => {
					await this.verifyBinary();
				})
			);

		// Version info container
		const versionEl = containerEl.createDiv({ cls: "claude-settings-version" });
		versionEl.id = "claude-version-info";

		// --- Allowed Tools ---
		new Setting(containerEl).setName("Allowed tools").setHeading();

		new Setting(containerEl).setDesc(
			"Select which tools Claude Code is allowed to use."
		);

		for (const tool of ALL_TOOLS) {
			new Setting(containerEl)
				.setName(tool)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.allowedTools.includes(tool))
						.onChange(async (enabled) => {
							if (enabled) {
								if (!this.plugin.settings.allowedTools.includes(tool)) {
									this.plugin.settings.allowedTools.push(tool);
								}
							} else {
								this.plugin.settings.allowedTools =
									this.plugin.settings.allowedTools.filter((t) => t !== tool);
							}
							await this.plugin.saveSettings();
						})
				);
		}

		// --- Behavior ---
		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Auto-authorize")
			.setDesc(
				"Automatically approve tool use without prompting. Use with caution."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoAuthorize)
					.onChange(async (value) => {
						this.plugin.settings.autoAuthorize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Session persistence")
			.setDesc("Keep chat sessions across plugin reloads.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.sessionPersistence)
					.onChange(async (value) => {
						this.plugin.settings.sessionPersistence = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Response timeout")
			.setDesc("Maximum time (seconds) to wait for a Claude response.")
			.addText((text) =>
				text
					.setPlaceholder("120")
					.setValue(String(this.plugin.settings.maxResponseTimeout))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxResponseTimeout = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// --- System Prompt ---
		new Setting(containerEl).setName("System prompt").setHeading();

		new Setting(containerEl)
			.setName("Default system prompt")
			.setDesc("Additional instructions appended to every request.")
			.addTextArea((text) =>
				text
					.setPlaceholder("e.g. Always respond in markdown. Keep answers concise.")
					.setValue(this.plugin.settings.defaultSystemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.defaultSystemPrompt = value;
						await this.plugin.saveSettings();
					})
			);

		// Make the textarea larger
		const systemPromptTextarea = containerEl.querySelector(
			".setting-item:last-child textarea"
		) as HTMLTextAreaElement | null;
		if (systemPromptTextarea) {
			systemPromptTextarea.style.width = "100%";
			systemPromptTextarea.style.minHeight = "80px";
		}
	}

	private async verifyBinary(): Promise<void> {
		const versionEl = document.getElementById("claude-version-info");
		if (!versionEl) return;

		versionEl.empty();
		versionEl.setText("Checking...");

		try {
			const { exec } = require("child_process") as typeof import("child_process");
			const path = this.plugin.settings.claudeBinaryPath || "claude";

			exec(`${path} --version`, { timeout: 5000 }, (error, stdout, stderr) => {
				if (versionEl) {
					versionEl.empty();
					if (error) {
						versionEl.addClass("claude-settings-error");
						versionEl.removeClass("claude-settings-success");
						versionEl.setText(`Not found: ${error.message}`);
						new Notice("Claude Code CLI not found at configured path.");
					} else {
						versionEl.removeClass("claude-settings-error");
						versionEl.addClass("claude-settings-success");
						versionEl.setText(`Found: ${stdout.trim()}`);
						new Notice(`Claude Code CLI found: ${stdout.trim()}`);
					}
				}
			});
		} catch (e) {
			if (versionEl) {
				versionEl.addClass("claude-settings-error");
				versionEl.setText(`Error: ${(e as Error).message}`);
			}
		}
	}
}
