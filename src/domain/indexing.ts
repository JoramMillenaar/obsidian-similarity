import {
	IndexingWarning,
	PrepareNoteRejectReason,
	PrepareNoteResult,
	SimilaritySettings,
} from "../types";
import { normalizeWhitespace } from "./text";

const SEMANTIC_CONTENT_PATTERN = /[\p{L}\p{N}]/u;

export function truncateText(
	text: string,
	maxChars: number,
	warning: IndexingWarning,
	warnings: IndexingWarning[],
): string {
	if (maxChars <= 0 || text.length <= maxChars) {
		return text;
	}

	warnings.push(warning);
	return text.slice(0, maxChars);
}

export function hasSemanticContent(text: string): boolean {
	return SEMANTIC_CONTENT_PATTERN.test(text);
}

export function prepareExtractedNoteForEmbedding(args: {
	noteId: string;
	title: string;
	extractedText: string;
	settings: SimilaritySettings;
	warnings?: IndexingWarning[];
}): PrepareNoteResult {
	const warnings = [...(args.warnings ?? [])];
	const normalizedText = normalizeWhitespace(args.extractedText);

	if (!normalizedText) {
		return reject("empty-content", warnings);
	}

	if (!hasSemanticContent(normalizedText)) {
		return reject("non-semantic-content", warnings);
	}

	const weightedText = applyTitleWeight(
		normalizedText,
		args.title,
		args.settings.titleWeight,
	);
	const preparedText = truncateText(
		weightedText,
		args.settings.maxExtractedChars,
		"prepared-text-truncated",
		warnings,
	);

	if (!preparedText) {
		return reject("empty-content", warnings);
	}

	return {
		status: "ready",
		value: {
			noteId: args.noteId,
			preparedText,
			warnings,
		},
	};
}

function applyTitleWeight(text: string, title: string, titleWeight: number): string {
	const normalizedTitle = normalizeWhitespace(title);
	if (!normalizedTitle || titleWeight <= 0) {
		return text;
	}

	return normalizeWhitespace(
		`${Array.from({length: titleWeight}, () => normalizedTitle).join("\n")}\n\n${text}`,
	);
}

function reject(reason: PrepareNoteRejectReason, warnings: IndexingWarning[]): PrepareNoteResult {
	return {
		status: "reject",
		reason,
		warnings,
	};
}
