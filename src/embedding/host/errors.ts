/** Thrown when the worker reports it could not load the model, or never finished initializing in time. */
export class ModelLoadFailedError extends Error {
	constructor(message: string, readonly offline: boolean) {
		super(message);
		this.name = "ModelLoadFailedError";
	}
}
