import * as vscode from 'vscode';
import { Logger } from '../core/ports';

export class OutputLogger implements Logger {
	constructor(private readonly channel: vscode.LogOutputChannel) {}

	debug(message: string): void { this.channel.debug(message); }
	info(message: string): void { this.channel.info(message); }
	warn(message: string): void { this.channel.warn(message); }
	error(message: string): void { this.channel.error(message); }
}
