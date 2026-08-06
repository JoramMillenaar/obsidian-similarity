import { IndexedNote } from "../types";

export interface IndexStorage {
	getAll(): Promise<IndexedNote[]>;

	rewrite(index: IndexedNote[]): Promise<void>;

	isEmpty(): Promise<boolean>;

	repair(): Promise<void>;
}
