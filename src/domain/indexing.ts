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

	const preparedText = truncateText(
		normalizedText,
		args.settings.maxExtractedChars,
		"prepared-text-truncated",
		warnings,
	);

	return {
		status: "ready",
		value: {
			noteId: args.noteId,
			preparedText,
			warnings,
		},
	};
}

function reject(reason: PrepareNoteRejectReason, warnings: IndexingWarning[]): PrepareNoteResult {
	return {
		status: "reject",
		reason,
		warnings,
	};
}
