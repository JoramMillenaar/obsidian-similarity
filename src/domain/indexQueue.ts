/**
 * Ordering for the embedding backlog: three priority tiers, each a FIFO set
 * of keys whose work is pending. `high` drains before `medium` before `low`.
 * Actions aren't decided here — the queue's owner resolves what a key
 * actually needs when it's taken off, so drift between this queue and
 * whatever it backs is harmless.
 */
export type Priority = "high" | "medium" | "low";

const TIERS: Priority[] = ["high", "medium", "low"];
const RANK: Record<Priority, number> = {high: 2, medium: 1, low: 0};

export class IndexQueue {
	private tiers: Record<Priority, Set<string>> = {
		high: new Set(),
		medium: new Set(),
		low: new Set(),
	};

	get pending(): number {
		return this.tiers.high.size + this.tiers.medium.size + this.tiers.low.size;
	}

	get isEmpty(): boolean {
		return this.pending === 0;
	}

	has(id: string): boolean {
		return TIERS.some((tier) => this.tiers[tier].has(id));
	}

	priorityOf(id: string): Priority | undefined {
		return TIERS.find((tier) => this.tiers[tier].has(id));
	}

	/** Adds a key at the given priority, or promotes it if already queued at a lower one. Never downgrades. */
	enqueue(id: string, priority: Priority): void {
		const current = this.priorityOf(id);
		if (current && RANK[current] >= RANK[priority]) return;
		if (current) this.tiers[current].delete(id);
		this.tiers[priority].add(id);
	}

	take(): string | null {
		for (const tier of TIERS) {
			const next = takeFrom(this.tiers[tier]);
			if (next != null) return next;
		}
		return null;
	}

	clear(): void {
		for (const tier of TIERS) this.tiers[tier].clear();
	}
}

function takeFrom(tier: Set<string>): string | null {
	const next = tier.values().next();
	if (next.done) return null;
	tier.delete(next.value);
	return next.value;
}
