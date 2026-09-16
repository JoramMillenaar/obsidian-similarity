import { EmbeddingModel } from '../model';
import { makeGenerateDocumentEmbeddings, GenerateDocumentEmbeddings } from '../embedDocument';
import { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Entry point bundled into the embedding Worker. Owns the worker-side model instance and
 * dispatches `WorkerRequest` messages from the host, replying with `WorkerResponse` messages.
 */

let model: EmbeddingModel | null = null;
let generateDocumentEmbeddings: GenerateDocumentEmbeddings | null = null;

function post(message: WorkerResponse): void {
	(self as unknown as { postMessage(message: WorkerResponse): void }).postMessage(message);
}

/** Creates the worker-side model and reports 'ready' or 'model-load-error' once loading settles. */
async function handleInit(config: WorkerRequest & { type: 'init' }): Promise<void> {
	model = new EmbeddingModel(config.config, (progress) => {
		post({
			type: 'model-load-progress',
			progress: progress.progress,
			file: progress.file,
			loaded: progress.loaded,
			total: progress.total,
		});
	});
	generateDocumentEmbeddings = makeGenerateDocumentEmbeddings(model);

	try {
		await model.ready;
		post({type: 'ready', device: model.getDevice()});
	} catch (error) {
		post({
			type: 'model-load-error',
			message: error instanceof Error ? error.message : String(error),
			offline: !navigator.onLine,
		});
	}
}

/** Acks the embed request, then generates and posts back its embeddings (or an error). */
async function handleEmbed(message: WorkerRequest & { type: 'embed' }): Promise<void> {
	const {requestId, payload, maxOverlapPercent, maxChunkSize} = message;
	post({type: 'ack', requestId});

	try {
		if (!generateDocumentEmbeddings) throw new Error("Embedding model has not been initialized");
		const data = await generateDocumentEmbeddings(payload, maxOverlapPercent, maxChunkSize);
		post({type: 'embed-result', requestId, data});
	} catch (error) {
		post({requestId, type: 'embed-error', message: error instanceof Error ? error.message : String(error)});
	}
}

/** Disposes the worker-side model and confirms with a 'disposed' response, even if disposal itself fails. */
async function handleDispose(message: WorkerRequest & { type: 'dispose' }): Promise<void> {
	try {
		await model?.dispose();
	} catch (error) {
		console.error("[Similarity] Worker failed to dispose the embedding model:", error);
	} finally {
		post({type: 'disposed', requestId: message.requestId});
	}
}

/** Routes an incoming `WorkerRequest` to its handler by type. */
async function handleMessage(message: WorkerRequest): Promise<void> {
	if (message.type === 'init') return handleInit(message);
	if (message.type === 'embed') return handleEmbed(message);
	if (message.type === 'dispose') return handleDispose(message);
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
	void handleMessage(event.data);
});
