interface DequeNode {
	value: string;
	prev: DequeNode | null;
	next: DequeNode | null;
}

export class UniqueDeque {
	private map = new Map<string, DequeNode>();
	private head: DequeNode | null = null; // left / front
	private tail: DequeNode | null = null; // right / back

	// ---- construction / serialization ----

	static fromArray(values: string[]): UniqueDeque {
		const deque = new UniqueDeque();
		for (const value of values) deque.addRight(value);
		return deque;
	}

	toArray(): string[] {
		return [...this];
	}

	clone(): UniqueDeque {
		return UniqueDeque.fromArray(this.toArray());
	}

	// ---- core deque ops ----

	addRight(value: string): void {
		if (this.map.has(value)) return;
		const node: DequeNode = {value, prev: this.tail, next: null};
		if (this.tail) this.tail.next = node;
		this.tail = node;
		if (!this.head) this.head = node;
		this.map.set(value, node);
	}

	addLeft(value: string): void {
		if (this.map.has(value)) return;
		const node: DequeNode = {value, prev: null, next: this.head};
		if (this.head) this.head.prev = node;
		this.head = node;
		if (!this.tail) this.tail = node;
		this.map.set(value, node);
	}

	popRight(): string | undefined {
		if (!this.tail) return undefined;
		const value = this.tail.value;
		this.removeNode(this.tail);
		return value;
	}

	popLeft(): string | undefined {
		if (!this.head) return undefined;
		const value = this.head.value;
		this.removeNode(this.head);
		return value;
	}

	// ---- move-to-end variants (bump semantics) ----

	bumpLeft(value: string): void {
		const existing = this.map.get(value);
		if (existing) this.removeNode(existing);
		this.addLeft(value);
	}

	bumpRight(value: string): void {
		const existing = this.map.get(value);
		if (existing) this.removeNode(existing);
		this.addRight(value);
	}

	// ---- batch ops ----

	remove(value: string): boolean {
		const node = this.map.get(value);
		if (!node) return false;
		this.removeNode(node);
		return true;
	}

	removeMany(values: string[]): void {
		for (const value of values) this.remove(value);
	}

	mergeRight(other: UniqueDeque | string[]): void {
		for (const value of other) this.addRight(value);
	}

	mergeLeft(other: UniqueDeque | string[]): void {
		const values = [...other];
		for (let i = values.length - 1; i >= 0; i--) this.addLeft(values[i]);
	}

	// ---- inspection ----

	has(value: string): boolean {
		return this.map.has(value);
	}

	peekLeft(): string | undefined {
		return this.head?.value;
	}

	peekRight(): string | undefined {
		return this.tail?.value;
	}

	get length(): number {
		return this.map.size;
	}

	get isEmpty(): boolean {
		return this.map.size === 0;
	}

	* [Symbol.iterator](): Iterator<string> {
		let node = this.head;
		while (node) {
			yield node.value;
			node = node.next;
		}
	}

	// ---- internal ----

	private removeNode(node: DequeNode): void {
		if (node.prev) node.prev.next = node.next;
		else this.head = node.next;

		if (node.next) node.next.prev = node.prev;
		else this.tail = node.prev;

		this.map.delete(node.value);
	}
}
