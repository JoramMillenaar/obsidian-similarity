import { setIcon } from "obsidian";

export const WARNING_ICON = "alert-triangle";

export function createWarningIcon(parent: HTMLElement): HTMLElement {
	const icon = parent.createSpan({cls: "similarity-warning-icon"});
	setIcon(icon, WARNING_ICON);
	return icon;
}
