/**
 * DEV-ONLY modal that visualizes the MD→semantic-text→chunk pipeline for the
 * active note. See `inspectNotePipeline.ts` for how the stages are produced.
 *
 * Styling is injected as a scoped <style> on open (and removed on close) so no
 * dev CSS leaks into the shipped `styles.css`. Reached only behind `__DEV__`.
 */
import { App, Modal } from "obsidian";
import { EmbeddedChunk, EmbeddingPort, MarkdownTextExtractor, NoteSource, SettingsRepository } from "../ports";
import { inspectNotePipeline, NotePipelineInspection } from "./inspectNotePipeline";

const STYLE_ID = "spr-note-pipeline-inspector-style";

export type NotePipelineInspectorDeps = {
	noteSource: NoteSource;
	markdownTextExtractor: MarkdownTextExtractor;
	settingsRepo: SettingsRepository;
	embedder: EmbeddingPort;
};

export class NotePipelineInspectorModal extends Modal {
	constructor(
		app: App,
		private readonly deps: NotePipelineInspectorDeps,
		private readonly noteId: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.injectStyle();
		this.modalEl.addClass("spr-inspector-modal");
		this.titleEl.setText("Note pipeline inspector");
		this.contentEl.addClass("spr-inspector");

		const loading = this.contentEl.createDiv({ cls: "spr-loading", text: "Running pipeline…" });

		void inspectNotePipeline(this.deps, this.noteId)
			.then((inspection) => {
				loading.remove();
				if (!inspection) {
					this.contentEl.createDiv({ cls: "spr-error", text: `Note not found: ${this.noteId}` });
					return;
				}
				this.render(inspection);
			})
			.catch((error) => {
				loading.remove();
				console.error("[Similarity][dev] Pipeline inspection failed", error);
				this.contentEl.createDiv({
					cls: "spr-error",
					text: `Inspection failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
		activeDocument.getElementById(STYLE_ID)?.remove();
	}

	private render(inspection: NotePipelineInspection): void {
		this.renderHeader(inspection);
		this.renderNotices(inspection);
		this.renderExtractionSection(inspection);
		this.renderChunkSection(inspection);
	}

	private renderHeader(inspection: NotePipelineInspection): void {
		const header = this.contentEl.createDiv({ cls: "spr-header" });
		header.createDiv({ cls: "spr-note-path", text: inspection.note.id });

		const { settings } = inspection;
		const meta = header.createDiv({ cls: "spr-meta" });
		this.metaPill(meta, "maxRawMarkdownChars", settings.maxRawMarkdownChars);
		this.metaPill(meta, "maxExtractedChars", settings.maxExtractedChars);
		this.metaPill(meta, "maxOverlapPercent", `${settings.maxOverlapPercent}%`);
	}

	private metaPill(container: HTMLElement, label: string, value: string | number): void {
		const pill = container.createSpan({ cls: "spr-pill" });
		pill.createSpan({ cls: "spr-pill-key", text: label });
		pill.createSpan({ cls: "spr-pill-val", text: String(value) });
	}

	private renderNotices(inspection: NotePipelineInspection): void {
		if (inspection.rawMarkdownTruncated) {
			this.contentEl.createDiv({
				cls: "spr-notice spr-notice-warn",
				text: "⚠ Raw markdown was truncated before extraction (maxRawMarkdownChars).",
			});
		}
		if (inspection.preparedTextTruncated) {
			this.contentEl.createDiv({
				cls: "spr-notice spr-notice-warn",
				text: "⚠ Prepared text was truncated before chunking (maxExtractedChars).",
			});
		}
	}

	// ── ① Markdown → semantic text ──────────────────────────────────────────
	private renderExtractionSection(inspection: NotePipelineInspection): void {
		const section = this.section("① Markdown → semantic text");

		const raw = section.createEl("details", { cls: "spr-collapse" });
		raw.createEl("summary", {
			text: `Raw markdown (${inspection.boundedMarkdown.length.toLocaleString()} chars`
				+ `${inspection.rawMarkdownTruncated ? ", truncated" : ""})`,
		});
		raw.createEl("pre", { cls: "spr-text spr-text-raw", text: inspection.boundedMarkdown });

		section.createDiv({ cls: "spr-subhead", text: `Extracted text (${inspection.extractedText.length.toLocaleString()} chars)` });
		if (inspection.extractedText) {
			section.createEl("pre", { cls: "spr-text spr-text-extracted", text: inspection.extractedText });
		} else {
			section.createDiv({ cls: "spr-empty", text: "— empty —" });
		}
	}

	// ── ② Chunking over the prepared text ───────────────────────────────────
	private renderChunkSection(inspection: NotePipelineInspection): void {
		const section = this.section("② Chunking (over prepared text)");
		section.createDiv({
			cls: "spr-hint",
			text: "Prepared text = extracted text, truncated to maxExtractedChars. "
				+ "Chunk start/end offsets index into this exact string.",
		});

		const { preparedText, chunks } = inspection;
		if (!preparedText) {
			section.createDiv({ cls: "spr-empty", text: "No prepared text — nothing left after extraction." });
			return;
		}

		this.renderLegend(section);
		this.renderChunkMap(section, preparedText, chunks);
		this.renderChunkTable(section, preparedText, chunks);
	}

	private renderLegend(section: HTMLElement): void {
		const legend = section.createDiv({ cls: "spr-legend" });
		legend.createSpan({ cls: "spr-legend-item spr-seg-0", text: "chunk (even)" });
		legend.createSpan({ cls: "spr-legend-item spr-seg-1", text: "chunk (odd)" });
		legend.createSpan({ cls: "spr-legend-item spr-seg-overlap", text: "overlap" });
		legend.createSpan({ cls: "spr-legend-item spr-seg-gap", text: "gap (unchunked)" });
	}

	/**
	 * Renders the prepared text once, split at every chunk boundary. Each segment
	 * is shaded by the chunk(s) covering it, so overlaps and gaps are visible, and
	 * numbered chips mark where each chunk opens (▸n) and closes (◂n).
	 */
	private renderChunkMap(section: HTMLElement, text: string, chunks: EmbeddedChunk[]): void {
		const map = section.createEl("pre", { cls: "spr-text spr-chunk-map" });
		if (chunks.length === 0) {
			map.setText(text);
			return;
		}

		const points = new Set<number>([0, text.length]);
		for (const chunk of chunks) {
			points.add(clamp(chunk.start, 0, text.length));
			points.add(clamp(chunk.end, 0, text.length));
		}
		const boundaries = [...points].sort((a, b) => a - b);

		for (let i = 0; i < boundaries.length; i++) {
			const at = boundaries[i];

			// Closing chips first, then opening chips, at this exact offset.
			chunks.forEach((chunk, idx) => {
				if (chunk.end === at) this.boundaryChip(map, idx, "close");
			});
			chunks.forEach((chunk, idx) => {
				if (chunk.start === at) this.boundaryChip(map, idx, "open");
			});

			const next = boundaries[i + 1];
			if (next === undefined || next === at) continue;

			const covering: number[] = [];
			chunks.forEach((chunk, idx) => {
				if (chunk.start <= at && chunk.end >= next) covering.push(idx);
			});

			const span = map.createSpan({ text: text.slice(at, next) });
			if (covering.length === 0) {
				span.addClass("spr-seg-gap");
			} else if (covering.length === 1) {
				span.addClass(`spr-seg-${covering[0] % 2}`);
			} else {
				span.addClass("spr-seg-overlap");
				span.setAttr("title", `chunks ${covering.join(", ")}`);
			}
		}
	}

	private boundaryChip(container: HTMLElement, idx: number, kind: "open" | "close"): void {
		container.createSpan({
			cls: `spr-chip spr-chip-${kind}`,
			text: kind === "open" ? `▸${idx}` : `◂${idx}`,
		});
	}

	private renderChunkTable(section: HTMLElement, text: string, chunks: EmbeddedChunk[]): void {
		section.createDiv({ cls: "spr-subhead", text: `Chunks (${chunks.length})` });
		if (chunks.length === 0) {
			section.createDiv({ cls: "spr-empty", text: "— no chunks —" });
			return;
		}

		const table = section.createEl("table", { cls: "spr-table" });
		const head = table.createEl("thead").createEl("tr");
		for (const col of ["#", "start", "end", "chars", "text"]) {
			head.createEl("th", { text: col });
		}

		const body = table.createEl("tbody");
		chunks.forEach((chunk, idx) => {
			const row = body.createEl("tr");
			const marker = row.createEl("td");
			marker.createSpan({ cls: `spr-chip spr-seg-${idx % 2}`, text: String(idx) });
			row.createEl("td", { text: String(chunk.start) });
			row.createEl("td", { text: String(chunk.end) });
			row.createEl("td", { text: String(Math.max(0, chunk.end - chunk.start)) });
			row.createEl("td", { cls: "spr-cell-text", text: text.slice(chunk.start, chunk.end) });
		});
	}

	private section(title: string): HTMLElement {
		const section = this.contentEl.createDiv({ cls: "spr-section" });
		section.createDiv({ cls: "spr-section-title", text: title });
		return section;
	}

	private injectStyle(): void {
		if (activeDocument.getElementById(STYLE_ID)) return;
		const style = activeDocument.head.createEl("style", { attr: { id: STYLE_ID } });
		style.setText(INSPECTOR_CSS);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

const INSPECTOR_CSS = `
.spr-inspector-modal { width: min(920px, 92vw); }
.spr-inspector { max-height: 78vh; overflow-y: auto; }
.spr-loading, .spr-error { padding: 12px 0; color: var(--text-muted); }
.spr-error { color: var(--text-error); }

.spr-header { margin-bottom: 10px; }
.spr-note-path { font-weight: 600; word-break: break-all; margin-bottom: 6px; }
.spr-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.spr-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
	background: var(--background-secondary); border: 1px solid var(--background-modifier-border);
	border-radius: 5px; padding: 2px 7px; }
.spr-pill-key { color: var(--text-muted); font-family: var(--font-monospace); }
.spr-pill-val { font-weight: 600; font-family: var(--font-monospace); }

.spr-notice { border-radius: 6px; padding: 7px 10px; margin: 8px 0; font-size: 13px; }
.spr-notice-warn { background: rgba(224, 169, 74, 0.12); color: var(--text-warning, #d08b28); }
.spr-notice-reject { background: rgba(224, 99, 122, 0.12); color: var(--text-error); }

.spr-section { margin-top: 18px; }
.spr-section-title { font-size: 13px; font-weight: 700; letter-spacing: 0.02em;
	text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;
	border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 4px; }
.spr-subhead { font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 12px 0 5px; }
.spr-hint { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; }
.spr-empty { color: var(--text-faint); font-style: italic; padding: 4px 0; }

.spr-collapse { margin-bottom: 6px; }
.spr-collapse > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); }

.spr-text { font-family: var(--font-monospace); font-size: 12px; line-height: 1.6;
	white-space: pre-wrap; word-break: break-word; background: var(--background-primary-alt);
	border: 1px solid var(--background-modifier-border); border-radius: 6px;
	padding: 10px; margin: 0; max-height: 260px; overflow-y: auto; }
.spr-text-raw { color: var(--text-muted); }

.spr-legend { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; font-size: 11px; }
.spr-legend-item { padding: 1px 7px; border-radius: 4px; }

.spr-chunk-map { line-height: 1.9; }
.spr-seg-0 { background: rgba(95, 208, 192, 0.22); }
.spr-seg-1 { background: rgba(120, 150, 230, 0.22); }
.spr-seg-overlap { background: rgba(224, 169, 74, 0.38); }
.spr-seg-gap { background: rgba(224, 99, 122, 0.16); border-bottom: 1px dashed var(--text-error); }

.spr-chip { font-family: var(--font-monospace); font-size: 10px; font-weight: 700;
	padding: 0 4px; border-radius: 3px; margin: 0 1px; vertical-align: baseline;
	color: var(--text-on-accent); background: var(--text-accent); }
.spr-chip-open { background: var(--color-green, #3aa675); color: #fff; }
.spr-chip-close { background: var(--color-red, #c0435a); color: #fff; }

.spr-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.spr-table th, .spr-table td { text-align: left; padding: 4px 8px;
	border-bottom: 1px solid var(--background-modifier-border); vertical-align: top; }
.spr-table th { color: var(--text-muted); font-weight: 600; }
.spr-table td:nth-child(2), .spr-table td:nth-child(3), .spr-table td:nth-child(4) {
	font-family: var(--font-monospace); white-space: nowrap; }
.spr-cell-text { font-family: var(--font-monospace); color: var(--text-muted);
	max-width: 460px; word-break: break-word; }
`;
