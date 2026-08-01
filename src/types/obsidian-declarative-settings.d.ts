// Speculative ambient types for Obsidian's declarative settings API
// (PluginSettingTab#getSettingDefinitions), documented for Obsidian 1.13.0+
// which is not yet in a public release and is not covered by the installed
// `obsidian` npm package's type definitions (currently 1.7.2).
//
// These types are hand-authored from the migration guide and may not match
// the shipped API exactly. Treat as provisional until Obsidian 1.13.0 lands
// and the official types are updated.

import "obsidian";

declare module "obsidian" {
	interface SettingControlBase {
		key: string;
		disabled?: boolean | (() => boolean);
	}

	interface ToggleControlDefinition extends SettingControlBase {
		type: "toggle";
	}

	interface DropdownControlDefinition extends SettingControlBase {
		type: "dropdown";
		defaultValue?: string;
		options: Record<string, string>;
	}

	interface TextControlDefinition extends SettingControlBase {
		type: "text";
		placeholder?: string;
		defaultValue?: string;
		validate?: (value: string) => string | undefined | Promise<string | undefined>;
	}

	interface TextareaControlDefinition extends SettingControlBase {
		type: "textarea";
		placeholder?: string;
		rows?: number;
		defaultValue?: string;
		validate?: (value: string) => string | undefined | Promise<string | undefined>;
	}

	interface NumberControlDefinition extends SettingControlBase {
		type: "number";
		min?: number;
		max?: number;
		step?: number;
		placeholder?: string;
		defaultValue?: number;
		validate?: (value: number) => string | undefined | Promise<string | undefined>;
	}

	type SettingControlDefinition =
		| ToggleControlDefinition
		| DropdownControlDefinition
		| TextControlDefinition
		| TextareaControlDefinition
		| NumberControlDefinition;

	interface SettingDefinition {
		name: string;
		desc?: string | DocumentFragment;
		/** Mutually exclusive with `render` and `action`. */
		control?: SettingControlDefinition;
		/** Full manual control over the row. Mutually exclusive with `control` and `action`. */
		render?: (setting: Setting) => (() => void) | void;
		/** Mutually exclusive with `control` and `render`. */
		action?: (index: number) => void;
		/** Conditional visibility, re-evaluated whenever the tab updates. */
		visible?: () => boolean;
		/** Excludes this row from global settings search. */
		searchable?: boolean;
	}

	interface SettingDefinitionGroup {
		type: "group";
		heading: string;
		items: SettingDefinition[];
		visible?: () => boolean;
	}

	type AnySettingDefinition = SettingDefinition | SettingDefinitionGroup;

	interface PluginSettingTab {
		/**
		 * Obsidian 1.13.0+: return declarative setting definitions. Obsidian
		 * renders from this array and skips `display()`. Returning an empty
		 * array falls back to `display()`.
		 */
		getSettingDefinitions?(): AnySettingDefinition[];
		/** Re-runs `getSettingDefinitions()` and re-renders the declarative tab. */
		update?(): void;
		/** Re-evaluates `visible`/`disabled` predicates without a full re-render. */
		refreshDomState?(): void;
		/** Override to read control values from storage other than `this.plugin.settings`. */
		getControlValue?(key: string): unknown;
		/** Override to write control values to storage other than `this.plugin.settings`. */
		setControlValue?(key: string, value: unknown): void | Promise<void>;
	}
}
