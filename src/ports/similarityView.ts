export interface ActivateOptions {
	reveal?: boolean;
	focus?: boolean;
}

export interface SimilarityView {
	activate(options?: ActivateOptions): Promise<void>;
	refreshResults(): void;
}
