import { EmbeddingModelConfig, IframeMessage } from 'src/types';
import { EmbeddingModel } from './embeddingModel';
import { makeGenerateDocumentEmbeddings } from './generateDocumentEmbeddings';

declare global {
	interface Window {
		/** Embedded into this document's srcdoc by IframeMessenger — see messagingService.ts. */
		__EMBEDDING_MODEL_CONFIG__: EmbeddingModelConfig;
	}
}

/**
 * Composition root for the iframe bundle (see esbuild.config.mjs — this file
 * is the entrypoint). Wires the model adapter to the embedding use case and
 * speaks the postMessage transport protocol to the host page.
 *
 * The model config is fixed for this realm's whole lifetime — it's baked
 * into the document by the host before this script ever runs (see
 * messagingService.ts#buildSrcdoc). Switching models means tearing down the
 * iframe and creating a new one, not reconfiguring this one, so there's
 * nothing to renegotiate over postMessage.
 */
const model = new EmbeddingModel(window.__EMBEDDING_MODEL_CONFIG__);
const generateDocumentEmbeddings = makeGenerateDocumentEmbeddings(model);

async function handleMessage(event: MessageEvent<IframeMessage>): Promise<void> {
	const { requestId, payload, maxOverlapPercent, maxChunkSize } = event.data;

	if (payload === 'ping') {
		await model.ready;
		(event.source as Window).postMessage(
			{ requestId, data: [], device: model.getDevice() },
			window.origin
		);
		return;
	}

	try {
		const embeddings = await generateDocumentEmbeddings(payload, maxOverlapPercent, maxChunkSize);
		(event.source as Window).postMessage({ requestId, data: embeddings }, window.origin);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		(event.source as Window).postMessage({ requestId, data: [], error: message }, window.origin);
	}
}

window.addEventListener('message', (event: MessageEvent<IframeMessage>) => {
	void handleMessage(event);
});
