import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Plugin } from "obsidian";
import { QuickAction, DEFAULT_QUICK_ACTIONS } from "./quick-actions";

export interface ClaudeCodeSettings {
	claudeBinaryPath: string;
	model: string;
	allowedTools: string[];
	autoAuthorize: boolean;
	sessionPersistence: boolean;
	maxResponseTimeout: number;
	defaultSystemPrompt: string;
	maxAtReferenceChars: number;
	enableGraphContext: boolean;
	maxGraphNotes: number;
	graphSummaryLines: number;
	quickActions: QuickAction[];
}

export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
	claudeBinaryPath: "claude",
	model: "sonnet",
	allowedTools: ["Read", "Bash", "Glob", "Grep"],
	autoAuthorize: false,
	sessionPersistence: true,
	maxResponseTimeout: 120,
	defaultSystemPrompt: "",
	maxAtReferenceChars: 8000,
	enableGraphContext: false,
	maxGraphNotes: 5,
	graphSummaryLines: 3,
	quickActions: DEFAULT_QUICK_ACTIONS,
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
			.setName("Model")
			.setDesc("Select which model to use.")
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
		new Setting(containerEl).setName("CLI").setHeading();

		new Setting(containerEl)
			.setName("Binary path")
			.setDesc("Path to the CLI binary. Leave as 'claude' to use the system path.")
			.addText((text) =>
				text
					.setPlaceholder("Claude")
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
			"Select which tools are allowed."
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
			.setDesc("Maximum time (seconds) to wait for a response.")
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
					.setPlaceholder("Always respond in markdown, keep answers concise")
					.setValue(this.plugin.settings.defaultSystemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.defaultSystemPrompt = value;
						await this.plugin.saveSettings();
					})
			);

		// Make the textarea larger
		const systemPromptTextarea = containerEl.querySelector<HTMLTextAreaElement>(
			".setting-item:last-child textarea"
		);
		if (systemPromptTextarea) {
			systemPromptTextarea.addClass("claude-settings-system-prompt");
		}

		// --- Context ---
		new Setting(containerEl).setName("Context").setHeading();

		new Setting(containerEl)
			.setName("Max @ reference characters")
			.setDesc("Maximum characters to include per @-referenced note.")
			.addText((text) =>
				text
					.setPlaceholder("8000")
					.setValue(String(this.plugin.settings.maxAtReferenceChars))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxAtReferenceChars = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// --- Graph Context ---
		new Setting(containerEl).setName("Graph context").setHeading();

		new Setting(containerEl)
			.setName("Enable graph context")
			.setDesc("Include outgoing links and backlinks of the active note as context.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableGraphContext)
					.onChange(async (value) => {
						this.plugin.settings.enableGraphContext = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max graph notes")
			.setDesc("Maximum number of linked notes to include per direction.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.maxGraphNotes))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxGraphNotes = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Graph summary lines")
			.setDesc("Number of lines to use as a summary for each linked note.")
			.addText((text) =>
				text
					.setPlaceholder("3")
					.setValue(String(this.plugin.settings.graphSummaryLines))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.graphSummaryLines = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// --- Quick Actions ---
		new Setting(containerEl).setName("Quick actions").setHeading();

		new Setting(containerEl).setDesc(
			"AI actions available in the right-click editor menu. Select text and right-click to use."
		);

		// Ensure quickActions is initialized
		if (!this.plugin.settings.quickActions) {
			this.plugin.settings.quickActions = [...DEFAULT_QUICK_ACTIONS];
		}

		for (const action of this.plugin.settings.quickActions) {
			new Setting(containerEl)
				.setName(action.label)
				.setDesc(`Mode: ${action.mode === "replace" ? "Replace selection" : "Insert after selection"}`)
				.addToggle((toggle) =>
					toggle.setValue(action.enabled).onChange(async (value) => {
						action.enabled = value;
						await this.plugin.saveSettings();
					})
				);
		}
	}

	private async verifyBinary(): Promise<void> {
		const versionEl = document.getElementById("claude-version-info");
		if (!versionEl) return;

		versionEl.empty();
		versionEl.setText("Checking...");

		try {
			const { exec } = await import("child_process");
			const path = this.plugin.settings.claudeBinaryPath || "claude";

			exec(`${path} --version`, { timeout: 5000 }, (error, stdout, stderr) => {
				if (versionEl) {
					versionEl.empty();
					if (error) {
						versionEl.addClass("claude-settings-error");
						versionEl.removeClass("claude-settings-success");
						versionEl.setText(`Not found: ${error.message}`);
						new Notice("CLI not found at configured path.");
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
