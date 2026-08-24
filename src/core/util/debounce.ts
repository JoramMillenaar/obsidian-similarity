export class KeyedDebouncer<K> {
	private pendingTimers = new Map<K, number>();

	constructor(private delayMs: number) {
	}

	schedule(key: K, callback: () => void | Promise<void>): void {
		const existing = this.pendingTimers.get(key);
		if (existing != null) window.clearTimeout(existing);

		const timerId = window.setTimeout(() => {
			this.pendingTimers.delete(key);
			void Promise.resolve(callback());
		}, this.delayMs);

		this.pendingTimers.set(key, timerId);
	}

	cancel(key?: K): void {
		if (key != null) {
			const timerId = this.pendingTimers.get(key);
			if (timerId != null) {
				window.clearTimeout(timerId);
				this.pendingTimers.delete(key);
			}
		} else {
			this.pendingTimers.forEach((timerId) => window.clearTimeout(timerId));
			this.pendingTimers.clear();
		}
	}
}

