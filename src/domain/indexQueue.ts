/**
 * Ordering for the sync backlog: two priority tiers, each a FIFO set of paths
 * whose index state is unknown. `urgent` drains before `backlog` entirely.
 * Actions aren't decided here — the worker resolves what a path actually
 * needs when it's taken off the queue, so drift between this queue and the
 * vault/index is harmless.
 */
export class IndexQueue {
	private urgent = new Set<string>();
	private backlog = new Set<string>();

	get pending(): number {
		return this.urgent.size + this.backlog.size;
	}

	get isEmpty(): boolean {
		return this.pending === 0;
	}

	has(id: string): boolean {
		return this.urgent.has(id) || this.backlog.has(id);
	}

	bump(id: string): void {
		this.backlog.delete(id);
		this.urgent.delete(id);
		this.urgent.add(id);
	}

	seed(ids: string[]): void {
		for (const id of ids) {
			if (this.urgent.has(id)) continue;
			this.backlog.add(id);
		}
	}

	take(): string | null {
		for (const tier of [this.urgent, this.backlog]) {
			const next = tier.values().next();
			if (!next.done) {
				tier.delete(next.value);
				return next.value;
			}
		}
		return null;
	}

	clear(): void {
		this.urgent.clear();
		this.backlog.clear();
	}
}
