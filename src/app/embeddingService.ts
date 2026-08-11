import { EmbeddingPort, EmbedOptions, EmbeddingResult } from "../ports";
import { EmbeddingModelId } from "../types";
import { EMBEDDING_MODELS } from "../constants";
import { JobQueue, JobQueueObserver, Priority } from "./jobQueue";
import { hashText } from "../domain/text";

export class EmbeddingService {
	constructor(private readonly embedder: EmbeddingPort, private readonly queue: JobQueue) {
	}

	embed(text: string, options: EmbedOptions, priority?: Priority): Promise<EmbeddingResult | null> {
		return this.queue.submit(hashText(text), () => this.embedder.embed(text, options), priority);
	}

	subscribe(observer: JobQueueObserver): () => void {
		return this.queue.subscribe(observer);
	}

	async swap(modelId: EmbeddingModelId): Promise<void> {
		await this.queue.reset();
		this.embedder.unload();
		await this.embedder.load(EMBEDDING_MODELS[modelId]);
	}

	unload(): void {
		this.queue.unload();
		this.embedder.unload();
	}
}
