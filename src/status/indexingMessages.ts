export type IndexingMessageContext = {
	recentTitles: string[];
};

export const INDEXING_WELCOME_MESSAGE =
	"Thanks for using Similarity! I'm reading through your notes to learn what each one is about. All of this happens on your device.";

const GENERAL_MESSAGES = [
	"Your notes never leave this device. No accounts, no cloud, no tracking.",
	"This sidebar shows notes related to the one you have open, even if they aren't linked.",
	"Each note is put into a 'meaning space'. Notes that are closer together are more similar.",
	"You could turn off your wifi right now and I'd keep going. No internet needed.",
	"This takes a moment because a small AI model is running right here on your device, not on someone's server.",
	"Writing about something you've dealt with before? Older notes about the same thing will show up next to it.",
	"Results may shift a little while I'm still reading. They settle once the bar is full.",
	"In semantic search, Ctrl/Cmd+Shift+Enter inserts a link to the result instead of opening it.",
];

const PERSONAL_MESSAGES: ((title: string) => string)[] = [
	(title) => `Just read "${title}". Soon you'll see which of your other notes are about the same thing.`,
	(title) => `Reading "${title}"... I'll bring it back up when you write about something similar.`,
	(title) => `"${title}" is in. Even if nothing links to it, it can still turn up when it's relevant.`,
];

const MAX_TITLE_CHARS = 40;
const PERSONAL_EVERY = 3;

export class IndexingMessages {
	private step = 0;
	private general = 0;
	private personal = 0;

	next(ctx: IndexingMessageContext): string {
		const step = this.step++;
		if (step === 0) return INDEXING_WELCOME_MESSAGE;

		const title = ctx.recentTitles[ctx.recentTitles.length - 1];
		if (title && step % PERSONAL_EVERY === 0) {
			return PERSONAL_MESSAGES[this.personal++ % PERSONAL_MESSAGES.length](shortenTitle(title));
		}

		return GENERAL_MESSAGES[this.general++ % GENERAL_MESSAGES.length];
	}
}

/** "Journal/2024/Trip to Lisbon.md" -> "Trip to Lisbon"; undefined for titles not worth showing. */
export function titleFromNoteId(noteId: string | undefined): string | undefined {
	if (!noteId) return undefined;
	const base = noteId.slice(noteId.lastIndexOf("/") + 1).replace(/\.md$/i, "").trim();
	if (!base || /^untitled/i.test(base)) return undefined;
	return base;
}

function shortenTitle(title: string): string {
	return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}
