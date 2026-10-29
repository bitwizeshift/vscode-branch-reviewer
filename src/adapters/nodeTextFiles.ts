import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TextFiles } from '../core/ports';

export class NodeTextFiles implements TextFiles {
	async read(file: string): Promise<string | undefined> {
		try {
			return await fs.readFile(file, 'utf8');
		} catch {
			return undefined;
		}
	}

	async write(file: string, text: string): Promise<void> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text, 'utf8');
	}

	async exists(file: string): Promise<boolean> {
		try {
			await fs.access(file);
			return true;
		} catch {
			return false;
		}
	}
}
