import { setIcon, setTooltip } from "obsidian";
import { RerankerStatus } from "../reranking/reranker";

export type RerankToggleState = {
	on: boolean;
	/** Results are being reranked right now. */
	busy: boolean;
	/** The model is downloaded, so turning it on costs no download (and questions turn it on). */
	downloaded: boolean;
	status: RerankerStatus;
};

export type RerankToggle = {
	render(state: RerankToggleState): void;
};

function tooltipFor({on, busy, downloaded, status}: RerankToggleState): string {
	if (!on) {
		return downloaded
			? "Rerank results by relevance. Turns on by itself when your search ends with “?”."
			: "Rerank results by relevance, for questions. Downloads a model of a few hundred MB the first time.";
	}
	if (status.kind === "error") return `Reranking failed: ${status.message} Click to try again.`;
	if (status.kind === "loading") {
		return status.progress === null ? "Loading the reranker…" : `Downloading the reranker… ${Math.round(status.progress)}%`;
	}
	return busy ? "Reranking results…" : "Results are reranked by relevance. Click to turn off.";
}

/** The switch right of the search input that turns reranking on and off, showing the model's state. */
export function mountRerankToggle(inputContainer: HTMLElement, onClick: () => void): RerankToggle {
	inputContainer.addClass("has-similarity-rerank");
	const button = inputContainer.createDiv({
		cls: "clickable-icon similarity-rerank-toggle",
		attr: {role: "switch", "aria-checked": "false"},
	});
	const icon = button.createSpan({cls: "similarity-rerank-icon"});
	const progress = button.createSpan({cls: "similarity-rerank-progress"});
	let iconName = "";

	// Keep the focus in the input, so typing carries on after a click.
	button.addEventListener("mousedown", (event) => event.preventDefault());
	button.addEventListener("click", onClick);

	return {
		render(state) {
			const {on, busy, status} = state;
			const failed = on && status.kind === "error";
			const loading = on && status.kind === "loading";

			button.toggleClass("is-active", on);
			button.toggleClass("is-working", loading || (on && busy));
			button.toggleClass("mod-warning", failed);
			button.setAttr("aria-checked", String(on));
			setTooltip(button, tooltipFor(state), {placement: "bottom"});

			const nextIcon = failed ? "alert-triangle" : "sparkles";
			if (nextIcon !== iconName) setIcon(icon, iconName = nextIcon);
			progress.setText(loading && status.progress !== null ? `${Math.round(status.progress)}%` : "");
		},
	};
}
