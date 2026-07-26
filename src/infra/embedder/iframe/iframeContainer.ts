import { IframeMessage } from 'src/types';
import { EmbeddingModel } from './embeddingModel';
import { makeGenerateDocumentEmbeddings } from './generateDocumentEmbeddings';

/**
 * Composition root for the iframe bundle (see esbuild.config.mjs — this file
 * is the entrypoint). Wires the model adapter to the embedding use case and
 * speaks the postMessage transport protocol to the host page.
 */
const model = new EmbeddingModel();
const generateDocumentEmbeddings = makeGenerateDocumentEmbeddings(model);

window.addEventListener('message', async (event: MessageEvent<IframeMessage>) => {
	const { requestId, payload, maxOverlapPercent } = event.data;

	if (payload === 'ping') {
		await model.ready;
		(event.source as Window).postMessage(
			{ requestId, data: [], device: model.getDevice() },
			window.origin
		);
		return;
	}

	try {
		const embeddings = await generateDocumentEmbeddings(payload, maxOverlapPercent);
		(event.source as Window).postMessage({ requestId, data: embeddings }, window.origin);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		(event.source as Window).postMessage({ requestId, data: [], error: message }, window.origin);
	}
});
