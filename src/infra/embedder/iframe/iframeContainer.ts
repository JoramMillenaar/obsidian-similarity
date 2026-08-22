import { EmbeddingModelConfig, IframeMessage } from 'src/types';
import { EmbeddingModel } from './embeddingModel';
import { makeGenerateDocumentEmbeddings } from './generateDocumentEmbeddings';

declare global {
	interface Window {
		__EMBEDDING_MODEL_CONFIG__: EmbeddingModelConfig;
	}
}

const model = new EmbeddingModel(window.__EMBEDDING_MODEL_CONFIG__, (progress) => {
	window.parent.postMessage({
		type: 'model-load-progress',
		progress: progress.progress,
		file: progress.file,
		loaded: progress.loaded,
		total: progress.total,
	}, window.origin);
});

model.ready.catch((error: unknown) => {
	window.parent.postMessage({
		type: 'model-load-error',
		message: error instanceof Error ? error.message : String(error),
		offline: !navigator.onLine,
	}, window.origin);
});

const generateDocumentEmbeddings = makeGenerateDocumentEmbeddings(model);

async function handleMessage(event: MessageEvent<IframeMessage>): Promise<void> {
	const { requestId, payload, maxOverlapPercent, maxChunkSize } = event.data;
	const source = event.source as Window;

	try {
		if (payload === 'ping') {
			await model.ready;
			source.postMessage(
				{
					requestId,
					data: { chunks: [], metadata: { embeddingModelId: model.config.id, maxOverlapPercent: 0 } },
					device: model.getDevice(),
				},
				window.origin
			);
			return;
		}

		source.postMessage({ type: 'ack', requestId }, window.origin);

		const embeddings = await generateDocumentEmbeddings(payload, maxOverlapPercent, maxChunkSize);
		source.postMessage({ requestId, data: embeddings }, window.origin);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		source.postMessage({ requestId, data: [], error: message }, window.origin);
	}
}

window.addEventListener('message', (event: MessageEvent<IframeMessage>) => {
	void handleMessage(event);
});
