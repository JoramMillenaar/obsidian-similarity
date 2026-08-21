import { SimilarNotesNotice } from "../app/similarNotesNotice";

export function textForNotice(notice: SimilarNotesNotice): string {
	switch (notice.kind) {
		case "no-active-note":
			return "Open a note to see similar notes.";
		case "unsupported-file":
			return "Similarity matching only supports Markdown/text-based notes.";
		case "ignored-path":
			return "This note is ignored by settings. Remove it from ignored paths to see similar notes.";
		case "model-error":
			return notice.offline
				? `${notice.message} This will resume on its own once you are back online.`
				: notice.message;
		case "warming-up":
			return "Similar notes will appear once loading finishes.";
		case "empty-index":
			return "No notes found to compare.";
		case "fatal-error":
			return notice.indexEmpty
				? "Indexing stopped before any results were ready."
				: "No similar notes matched yet. Indexing also hit an error, so results may be stale.";
		case "indexing":
			return notice.indexEmpty
				? "Notes are being processed. Similar notes will appear as it progresses."
				: "No notes were similar enough yet. More may appear while your notes are processed.";
	}
}
