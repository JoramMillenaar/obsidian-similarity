import { App, Modal, Notice, Setting } from "obsidian";
import { REPO_URL, SUPPORT_CONTACT } from "../constants";
import {
	EnvironmentInfo,
	FeedbackKind,
	FeedbackReport,
	formatReport,
	issueUrl,
	mailtoUrl,
} from "../core/feedback";

export type FeedbackRequest =
	| { kind: "bug" }
	| { kind: "feedback" };

export type OpenFeedback = (request: FeedbackRequest) => void;

export type FeedbackModalDeps = {
	collectEnvironment: () => EnvironmentInfo;
};

export const FEEDBACK_ACTIONS: {label: string; icon: string; run: (openFeedback: OpenFeedback) => void}[] = [
	{label: "Report a bug", icon: "bug", run: (openFeedback) => openFeedback({kind: "bug"})},
	{label: "Send feedback", icon: "message-square", run: (openFeedback) => openFeedback({kind: "feedback"})},
	{label: "Star on GitHub", icon: "star", run: () => window.open(REPO_URL)},
];

const COPY: Record<FeedbackKind, {title: string; prompt: string; placeholder: string}> = {
	bug: {
		title: "Report a bug",
		prompt: "What happened?",
		placeholder: "What did you do, what did you expect, and what happened instead?",
	},
	feedback: {
		title: "Send feedback",
		prompt: "What's on your mind?",
		placeholder: "Ideas, annoyances, praise — anything.",
	},
};

const ENVIRONMENT_DESC =
	"Obsidian and plugin version, OS, whether a GPU was used, model and index size. " +
	"Never your notes or file names. You can review everything before sending.";

export class FeedbackModal extends Modal {
	private description = "";
	private includeEnvironment: boolean;

	constructor(
		app: App,
		private readonly request: FeedbackRequest,
		private readonly deps: FeedbackModalDeps,
	) {
		super(app);
		this.includeEnvironment = request.kind !== "feedback";
	}

	onOpen(): void {
		const copy = COPY[this.request.kind];
		this.setTitle(copy.title);

		this.contentEl.createDiv({cls: "setting-item-name", text: copy.prompt});
		const textarea = this.contentEl.createEl("textarea", {
			cls: "similarity-feedback-text",
			attr: {placeholder: copy.placeholder, rows: "5"},
		});
		textarea.addEventListener("input", () => {
			this.description = textarea.value;
		});

		if (this.request.kind !== "feedback") {
			new Setting(this.contentEl)
				.setName("Include device and plugin info")
				.setDesc(ENVIRONMENT_DESC)
				.addToggle((toggle) => {
					toggle.setValue(this.includeEnvironment).onChange((value) => {
						this.includeEnvironment = value;
					});
				});
		}

		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText("Open GitHub issue").setCta().onClick(() => this.send(issueUrl(this.report(), REPO_URL)));
			})
			.addButton((button) => {
				button.setButtonText("Email").onClick(() => this.send(mailtoUrl(this.report(), SUPPORT_CONTACT)));
			})
			.addButton((button) => {
				button.setButtonText("Copy report").onClick(() => void this.copy());
			});

		textarea.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private report(): FeedbackReport {
		return {
			kind: this.request.kind,
			description: this.description,
			environment: this.includeEnvironment ? this.deps.collectEnvironment() : undefined,
		};
	}

	private send(url: string): void {
		window.open(url);
		this.close();
	}

	private async copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(formatReport(this.report()));
			new Notice("Report copied to clipboard.");
			this.close();
		} catch (error) {
			console.error("[Similarity] Could not copy the report:", error);
			new Notice("Could not copy the report. Try one of the other options.");
		}
	}
}
