import { EmbeddingModelId } from "../../types";
import { IndexFiles, IndexHandle, openIndex } from "./indexHandle";

/**
 * Keeps exactly one index open — the one for the model currently selected.
 *
 * The index is opened independently of the embedder, because reading and
 * ranking stored vectors needs no model: note-to-note results stay available
 * while the model is still downloading, and survive a load failure.
 */
export class IndexRegistry {
	private handle: IndexHandle | null = null;
	private pending: Promise<IndexHandle> | null = null;
	private pendingModelId: EmbeddingModelId | null = null;

	constructor(
		private readonly files: IndexFiles,
		private readonly options: { throttleMs?: number } = {},
	) {
	}

	/** The open index, or null before the first `use()` resolves. */
	current(): IndexHandle | null {
		return this.handle;
	}

	/** Opens the index for `modelId`, flushing and closing any other one first. */
	use(modelId: EmbeddingModelId): Promise<IndexHandle> {
		if (this.handle?.modelId === modelId && this.pending === null) {
			return Promise.resolve(this.handle);
		}
		if (this.pending && this.pendingModelId === modelId) {
			return this.pending;
		}

		const previous = this.pending ?? Promise.resolve(null);
		this.pendingModelId = modelId;

		const opening = previous
			.catch(() => null)
			.then(async () => {
				const open = this.handle;
				if (open && open.modelId !== modelId) {
					this.handle = null;
					await open.close().catch((error) => {
						console.error(`[Similarity] Failed to flush the ${open.modelId} index before switching:`, error);
					});
				}
				if (open && open.modelId === modelId) return open;

				const handle = await openIndex(this.files, modelId, this.options);
				this.handle = handle;
				return handle;
			})
			.finally(() => {
				if (this.pending === opening) {
					this.pending = null;
					this.pendingModelId = null;
				}
			});

		this.pending = opening;
		return opening;
	}

	async close(): Promise<void> {
		const open = this.handle;
		this.handle = null;
		this.pending = null;
		this.pendingModelId = null;
		if (open) await open.close();
	}
}
