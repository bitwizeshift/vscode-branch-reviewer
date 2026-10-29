import type { Memento } from 'vscode';
import { StateStore } from '../core/ports';

/** Persists a value in workspace state so a review survives a reload. */
export class MementoStore<T> implements StateStore<T> {
	constructor(private readonly memento: Memento, private readonly key: string) {}

	load(): T | undefined {
		return this.memento.get<T>(this.key);
	}

	async save(value: T | undefined): Promise<void> {
		await this.memento.update(this.key, value);
	}
}
