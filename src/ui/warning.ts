import { setIcon } from "obsidian";
import { BannerState } from "../status/notices";

export const WARNING_ICON = "alert-triangle";

export function createWarningIcon(parent: HTMLElement): HTMLElement {
	const icon = parent.createSpan({cls: "similarity-warning-icon"});
	setIcon(icon, WARNING_ICON);
	return icon;
}

export function renderBannerMessage(bannerEl: HTMLElement, banner: BannerState): void {
	const row = bannerEl.createDiv({cls: "similarity-index-banner-message"});
	if (banner.tone === "warning") createWarningIcon(row);
	row.createSpan({text: banner.message});
}
