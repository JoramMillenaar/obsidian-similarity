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
	bannerEl.empty();
	bannerEl.toggleClass("is-hidden", !banner.visible);
	if (!banner.visible) return;

	const row = bannerEl.createDiv({cls: "similarity-index-banner-message"});
	if (banner.tone === "warning") createWarningIcon(row);
	row.createSpan({text: banner.message});

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

	if (banner.total > 0) {
		const progressRow = bannerEl.createDiv({cls: "similarity-index-banner-progress"});
		progressRow.createEl("progress", {
			cls: "similarity-index-banner-bar",
			attr: {max: String(banner.total), value: String(Math.min(banner.processed, banner.total))},
		});
	}
}
