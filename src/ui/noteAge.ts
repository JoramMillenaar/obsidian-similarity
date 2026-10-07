import { App, moment as obsidianMoment, TFile } from "obsidian";
import type { Moment } from "moment";

const moment = obsidianMoment as unknown as (input?: number) => Moment;

export function noteAgeText(app: App, path: string): string | null {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;
	return moment(file.stat.ctime).fromNow();
}
