import * as vscode from 'vscode';
import { Logger } from '../core/ports';
import { ReviewController } from '../core/review/reviewController';
import { buildReviewViewModel, ReviewAction, SetupModel } from '../core/view/reviewViewModel';

type InboundMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'action'; readonly action: ReviewAction; readonly base?: string; readonly head?: string };

/** Hosts the Review panel and relays its buttons to the controller. */
export class ReviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'branchReviewer.review';

	private view: vscode.WebviewView | undefined;
	private setup: SetupModel = { branches: [] };
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(
		private readonly controller: ReviewController,
		private readonly extensionUri: vscode.Uri,
		private readonly logger: Logger,
	) {
		this.subscriptions.push(controller.onDidChange(() => this.render()));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		this.subscriptions.push(
			view.webview.onDidReceiveMessage((message: InboundMessage) => void this.receive(message)),
			view.onDidDispose(() => { this.view = undefined; }),
		);
	}

	/** Reloads the branch list shown before a review starts. */
	async refreshBranches(): Promise<void> {
		if (this.controller.review) {
			return;
		}
		try {
			this.setup = await this.controller.branchChoices();
		} catch (error) {
			this.logger.error(`Listing branches failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.render();
	}

	private async receive(message: InboundMessage): Promise<void> {
		if (message.type === 'ready') {
			await this.refreshBranches();
			this.render();
			return;
		}
		const { controller } = this;
		switch (message.action) {
			case 'start':
				if (message.base && message.head) {
					await controller.start(message.base, message.head);
				}
				break;
			case 'approve': await controller.approve(); break;
			case 'reject': await controller.reject(); break;
			case 'cancel': await controller.cancelReject(); break;
			case 'edit': await controller.edit(); break;
			case 'abandon': await controller.abort(); break;
			case 'resume': await controller.resume(); break;
			case 'quit': await controller.quit(); break;
			case 'continue': await controller.continueAfterConflict(); break;
			case 'dismiss': await controller.dismiss(); break;
		}
		if (!controller.review) {
			await this.refreshBranches();
		}
	}

	private render(): void {
		const model = buildReviewViewModel(this.controller.review, this.setup, this.controller.activity);
		void this.view?.webview.postMessage({ type: 'model', model });
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review.js'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${style}" rel="stylesheet">
	<title>Review</title>
</head>
<body>
	<main id="root"></main>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}
