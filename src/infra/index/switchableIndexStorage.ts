import { IndexBackend, IndexedNote } from "../../types";
import { IndexStorage } from "../../ports";

/**
 * An {@link IndexStorage} that delegates to one of several concrete backends,
 * selected at runtime. Lets the repository stay backend-agnostic while the
 * active backend can be switched (and migrated) from settings.
 */
export class SwitchableIndexStorage implements IndexStorage {
	constructor(
		private readonly backends: Record<IndexBackend, IndexStorage>,
		private active: IndexBackend,
	) {
	}

	getActive(): IndexBackend {
		return this.active;
	}

	setActive(backend: IndexBackend): void {
		this.active = backend;
	}

	storageFor(backend: IndexBackend): IndexStorage {
		return this.backends[backend];
	}

	getAll(): Promise<IndexedNote[]> {
		return this.current().getAll();
	}

	rewrite(index: IndexedNote[]): Promise<void> {
		return this.current().rewrite(index);
	}

	isEmpty(): Promise<boolean> {
		return this.current().isEmpty();
	}

	private current(): IndexStorage {
		return this.backends[this.active];
	}
}
