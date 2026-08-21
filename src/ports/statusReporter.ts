export interface StatusReporter {
	update(text: string, timeout?: number | null): void;

	clear(): void;
}
