/** Banner DOM: renders banner.ts state and animates the changes. */
import { setIcon } from "obsidian";
import { BannerState, WASM_WARNING_MESSAGE } from "../status/notices";
import { StatusHub } from "../status/statusHub";
import { Unsubscribe } from "../core/util/unsubscribe";
import { subscribeBanner } from "./banner";
import { WARNING_ICON } from "./warning";

export type BannerOptions = {
	before?: Node | null;
	onOpenSettings?: () => void;
};

export function mountBanner(parent: HTMLElement, statusHub: StatusHub, options: BannerOptions = {}): Unsubscribe {
	const view = new BannerView(options.onOpenSettings);
	parent.insertBefore(view.el, options.before ?? null);
	const unsubscribe = subscribeBanner(statusHub, (banner) => view.update(banner));
	return () => {
		unsubscribe();
		view.destroy();
	};
}

const TONE_ICONS: Partial<Record<BannerState["tone"], string>> = {
	warning: WARNING_ICON,
	success: "check-circle-2",
};

const MESSAGE_RESIZE_MS = 350;
const LEAVE_FALLBACK_MS = 600;
const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";
const PROGRESS_SMOOTHING_MS = 220;

class BannerView {
	readonly el: HTMLElement;
	private readonly card: HTMLElement;
	private readonly messageEl: HTMLElement;
	private readonly gpuWarningEl: HTMLElement;
	private readonly linkEl: HTMLElement;
	private readonly progressEl: HTMLElement;
	private readonly barEl: HTMLElement;
	private readonly fillEl: HTMLElement;
	private readonly hasOpenSettings: boolean;

	private shown = false;
	private messageKey?: string;
	private phase?: string;
	private resizeAnimation?: Animation;

	private progressTarget = 0;
	private progressShown = 0;
	private frame?: number;
	private lastFrameAt = 0;

	constructor(onOpenSettings?: () => void) {
		// Outer grid row animates 0fr <-> 1fr for a smooth collapse; the card is the visible box.
		this.el = createDiv({cls: "similarity-index-banner", attr: {"aria-hidden": "true"}});
		this.card = this.el.createDiv({cls: "similarity-index-banner-clip"}).createDiv({cls: "similarity-index-banner-card"});
		this.messageEl = this.card.createDiv({cls: "similarity-index-banner-message", attr: {"aria-live": "polite"}});
		this.gpuWarningEl = this.card.createDiv({cls: "similarity-index-banner-gpu-warning", text: WASM_WARNING_MESSAGE});
		this.linkEl = this.card.createEl("a", {cls: "similarity-index-banner-link", text: "Re-enable in settings"});
		this.linkEl.addEventListener("click", (event) => {
			event.preventDefault();
			onOpenSettings?.();
		});
		this.progressEl = this.card.createDiv({cls: "similarity-index-banner-progress"});
		this.barEl = this.progressEl.createDiv({cls: "similarity-bar similarity-index-banner-bar"});
		this.fillEl = this.barEl.createDiv({cls: "similarity-bar-fill"});
		this.linkEl.toggle(false);
		this.gpuWarningEl.toggle(false);
		this.hasOpenSettings = onOpenSettings !== undefined;
	}

	update(banner: BannerState) {
		const wasShown = this.shown;
		this.shown = banner.visible;
		this.el.toggleClass("is-shown", banner.visible);
		this.el.setAttr("aria-hidden", String(!banner.visible));
		// Leave the last content in place while hidden so the collapse animates something.
		if (!banner.visible) {
			this.stopProgress();
			return;
		}

		this.card.dataset.tone = banner.tone;
		this.setMessage(banner, wasShown && !prefersReducedMotion());
		this.gpuWarningEl.toggle(banner.wasmWarning);
		this.linkEl.toggle(banner.action === "open-settings" && this.hasOpenSettings);

		this.progressEl.toggle(banner.total > 0);
		this.barEl.toggleClass("similarity-tier-2", banner.tone !== "success");
		this.barEl.toggleClass("similarity-tier-3", banner.tone === "success");
		// Fill in from empty when the banner appears or moves to a new phase (download, indexing,
		// done), then glide between updates. Gliding backwards into a new phase reads as a bug.
		const phase = `${banner.tone}:${banner.rotating ?? false}`;
		if (!wasShown || (phase !== this.phase && banner.tone !== "success")) this.renderProgress(0);
		this.phase = phase;
		this.setProgress(banner.total > 0 ? Math.min(banner.processed / banner.total, 1) : 0);
	}

	destroy() {
		this.stopProgress();
		this.resizeAnimation?.cancel();
		this.el.remove();
	}

	private setMessage(banner: BannerState, animate: boolean) {
		const key = `${banner.tone}\n${banner.message}`;
		if (key === this.messageKey) return;
		this.messageKey = key;

		const fromHeight = this.messageEl.getBoundingClientRect().height;
		this.resizeAnimation?.cancel();
		for (const line of Array.from(this.messageEl.children)) {
			if (animate && !line.hasClass("is-leaving")) {
				line.addClass("is-leaving");
				line.addEventListener("animationend", () => line.remove(), {once: true});
				// animationend never fires while the pane isn't rendered (e.g. collapsed sidebar).
				window.setTimeout(() => line.remove(), LEAVE_FALLBACK_MS);
			} else {
				line.remove();
			}
		}

		const line = this.messageEl.createDiv({cls: "similarity-index-banner-line"});
		const icon = TONE_ICONS[banner.tone];
		if (icon) setIcon(line.createSpan({cls: "similarity-index-banner-icon"}), icon);
		line.createSpan({text: banner.message});
		if (!animate) return;

		line.addClass("is-entering");
		const toHeight = this.messageEl.getBoundingClientRect().height;
		if (Math.abs(toHeight - fromHeight) > 0.5) {
			this.resizeAnimation = this.messageEl.animate(
				[{height: `${fromHeight}px`}, {height: `${toHeight}px`}],
				{duration: MESSAGE_RESIZE_MS, easing: EASE_OUT},
			);
		}
	}

	private setProgress(ratio: number) {
		this.progressTarget = ratio;
		if (prefersReducedMotion()) {
			this.stopProgress();
			this.renderProgress(ratio);
			return;
		}
		if (this.frame === undefined && ratio !== this.progressShown) {
			this.lastFrameAt = performance.now();
			this.frame = this.el.win.requestAnimationFrame(this.tick);
		}
	}

	private tick = (now: number) => {
		const dt = Math.min(now - this.lastFrameAt, 100);
		this.lastFrameAt = now;
		const remaining = this.progressTarget - this.progressShown;
		const next = Math.abs(remaining) < 0.0005
			? this.progressTarget
			: this.progressShown + remaining * (1 - Math.exp(-dt / PROGRESS_SMOOTHING_MS));
		this.renderProgress(next);
		this.frame = next === this.progressTarget ? undefined : this.el.win.requestAnimationFrame(this.tick);
	};

	private renderProgress(ratio: number) {
		this.progressShown = ratio;
		this.fillEl.setCssProps({"--similarity-fill": `${ratio * 100}%`});
	}

	private stopProgress() {
		if (this.frame !== undefined) this.el.win.cancelAnimationFrame(this.frame);
		this.frame = undefined;
	}
}

function prefersReducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
