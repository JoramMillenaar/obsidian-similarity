import "obsidian";

// `App.setting` is undocumented but stable Obsidian API for opening the settings modal.
declare module "obsidian" {
	interface App {
		setting: {
			open(): void;
			openTabById(id: string): void;
		};
	}
}
