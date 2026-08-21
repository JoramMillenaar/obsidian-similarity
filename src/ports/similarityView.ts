export interface ActivateOptions {
	reveal?: boolean;
	focus?: boolean;
}

export type ActivateSimilarityViewUseCase = (options?: ActivateOptions) => Promise<void>;
