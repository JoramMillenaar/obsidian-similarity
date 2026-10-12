import { setIcon } from "obsidian";
import { BannerState, WASM_WARNING_MESSAGE } from "../status/notices";

export const WARNING_ICON = "alert-triangle";

export function createWarningIcon(parent: HTMLElement): HTMLElement {
	const icon = parent.createSpan({cls: "similarity-warning-icon"});
	setIcon(icon, WARNING_ICON);
	return icon;
}

/**
 * Fills a banner element from `banner`. The "Re-enable in settings" link is only shown
 * when the caller provides `onOpenSettings`.
 */
export function renderBanner(bannerEl: HTMLElement, banner: BannerState, onOpenSettings?: () => void): void {
	// Keep the progress row across renders so the fill can transition instead of being recreated.
	const existingRow = bannerEl.querySelector<HTMLElement>(":scope > .similarity-index-banner-progress");
	for (const child of Array.from(bannerEl.children)) {
		if (child !== existingRow) child.remove();
	}
	bannerEl.toggleClass("is-hidden", !banner.visible);
	if (!banner.visible) {
		delete bannerEl.dataset.message;
		existingRow?.remove();
		return;
	}

	const row = bannerEl.createDiv({cls: "similarity-index-banner-message"});
	if (banner.tone === "warning") createWarningIcon(row);
	row.createSpan({text: banner.message});
	// The row is rebuilt on every progress tick; only fade in when the text actually changed.
	if (banner.rotating && bannerEl.dataset.message !== undefined && bannerEl.dataset.message !== banner.message) {
		row.addClass("is-entering");
	}
	bannerEl.dataset.message = banner.message;

	if (banner.wasmWarning) {
		bannerEl.createDiv({
			cls: "similarity-index-banner-gpu-warning",
			text: WASM_WARNING_MESSAGE,
		});
	}

	if (banner.action === "open-settings" && onOpenSettings) {
		const link = bannerEl.createEl("a", {
			cls: "similarity-index-banner-link",
			text: "Re-enable in settings",
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			onOpenSettings();
		});
	}

	if (banner.total <= 0) {
		existingRow?.remove();
		return;
	}

	// Newly created elements were appended after the kept row; move them in front of it.
	if (existingRow) {
		const fresh = Array.from(bannerEl.children).filter((c) => c !== existingRow);
		for (const child of fresh) bannerEl.insertBefore(child, existingRow);
	}

	const progressRow = existingRow ?? bannerEl.createDiv({cls: "similarity-index-banner-progress"});
	let fill = progressRow.querySelector<HTMLElement>(".similarity-bar-fill");
	if (!fill) {
		const bar = progressRow.createDiv({cls: "similarity-bar similarity-tier-2 similarity-index-banner-bar"});
		fill = bar.createDiv({cls: "similarity-bar-fill"});
	}
	fill.setCssProps({"--similarity-fill": `${Math.min(banner.processed / banner.total, 1) * 100}%`});
}
