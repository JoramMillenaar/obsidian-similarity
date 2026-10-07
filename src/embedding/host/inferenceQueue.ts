import { EmbedLane } from '../../ports';

type Task = {
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

/**
 * The one place embedding work is serialized: runs a single inference at a time, taking
 * interactive tasks before background ones. Tasks are single chunks, so a search query
 * waits for at most one chunk of an indexing note, never the whole note.
 */
export class InferenceQueue {
	private readonly lanes: Record<EmbedLane, Task[]> = {interactive: [], background: []};
	private running: Promise<void> | null = null;
	private closed = false;

	run<T>(lane: EmbedLane, work: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error('model has been disposed'));

		return new Promise<T>((resolve, reject) => {
			this.lanes[lane].push({run: work, resolve: resolve as (value: unknown) => void, reject});
			if (!this.running) this.running = this.drain();
		});
	}

	/** Rejects everything still waiting and resolves once the running inference has settled. */
	async close(): Promise<void> {
		this.closed = true;
		for (const task of [...this.lanes.interactive.splice(0), ...this.lanes.background.splice(0)]) {
			task.reject(new Error('model has been disposed'));
		}
		await this.running;
	}

	private async drain(): Promise<void> {
		for (let task = this.next(); task; task = this.next()) {
			try {
				task.resolve(await task.run());
			} catch (error) {
				task.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		this.running = null;
	}

	private next(): Task | undefined {
		return this.lanes.interactive.shift() ?? this.lanes.background.shift();
	}
}
