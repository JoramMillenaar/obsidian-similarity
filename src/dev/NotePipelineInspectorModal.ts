/**
 * DEV-ONLY modal that visualizes the MD→semantic-text→chunk pipeline for the
 * active note. See `inspectNotePipeline.ts` for how the stages are produced.
 * Styling lives in `styles.css` (spr- prefixed rules). Reached only behind `__DEV__`.
 */
import { App, Modal } from "obsidian";
import { EmbeddedChunk, EmbeddingPort, NoteSource, SettingsRepository } from "../ports";
import { GetNoteTextUseCase } from "../app/getNoteText";
import { inspectNotePipeline, NotePipelineInspection } from "./inspectNotePipeline";

export type NotePipelineInspectorDeps = {
	noteSource: NoteSource;
	getNoteText: GetNoteTextUseCase;
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
		if (inspection.rawMarkdown.length > inspection.settings.maxRawMarkdownChars) {
			this.contentEl.createDiv({
				cls: "spr-notice spr-notice-warn",
				text: "⚠ Raw markdown was truncated before extraction (maxRawMarkdownChars).",
			});
		}
	}

	// ── ① Markdown → semantic text ──────────────────────────────────────────
	private renderExtractionSection(inspection: NotePipelineInspection): void {
		const section = this.section("① Markdown → semantic text");

		const raw = section.createEl("details", { cls: "spr-collapse" });
		raw.createEl("summary", {
			text: `Raw markdown (${inspection.rawMarkdown.length.toLocaleString()} chars)`,
		});
		raw.createEl("pre", { cls: "spr-text spr-text-raw", text: inspection.rawMarkdown });

		section.createDiv({ cls: "spr-subhead", text: `Prepared text (${inspection.preparedText.length.toLocaleString()} chars)` });
		if (inspection.preparedText) {
			section.createEl("pre", { cls: "spr-text spr-text-extracted", text: inspection.preparedText });
		} else {
			section.createDiv({ cls: "spr-empty", text: "— empty —" });
		}
	}

	// ── ② Chunking over the prepared text ───────────────────────────────────
	private renderChunkSection(inspection: NotePipelineInspection): void {
		const section = this.section("② Chunking (over prepared text)");
		section.createDiv({
			cls: "spr-hint",
			text: "Chunk start/end offsets index into the prepared text shown above.",
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

}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
