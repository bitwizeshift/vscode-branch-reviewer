// @ts-check
(function () {
	// @ts-ignore acquireVsCodeApi is injected by the webview host
	const vscode = acquireVsCodeApi();
	const root = /** @type {HTMLElement} */ (document.getElementById('root'));
	/** @type {{ base?: string, head?: string }} */
	const selection = vscode.getState() ?? {};

	/**
	 * @param {string} tag
	 * @param {Record<string, string>} [attributes]
	 * @param {(Node | string)[]} [children]
	 */
	function element(tag, attributes = {}, children = []) {
		const node = document.createElement(tag);
		for (const [name, value] of Object.entries(attributes)) {
			node.setAttribute(name, value);
		}
		node.append(...children);
		return node;
	}

	function send(action) {
		vscode.postMessage({ type: 'action', action, base: selection.base, head: selection.head });
	}

	function button(spec, disabled) {
		const node = element('button', { class: spec.appearance }, [spec.label]);
		node.disabled = disabled;
		node.addEventListener('click', () => send(spec.action));
		return node;
	}

	function branchSelect(id, label, branches, chosen, key) {
		const select = element('select', { id });
		for (const branch of branches) {
			const option = element('option', { value: branch }, [branch]);
			option.selected = branch === chosen;
			select.append(option);
		}
		select.addEventListener('change', () => {
			selection[key] = select.value;
			vscode.setState(selection);
		});
		return element('div', { class: 'field' }, [element('label', { for: id }, [label]), select]);
	}

	function render(model) {
		const busy = model.busy !== undefined;
		const content = element('div', { class: 'content' });

		if (model.setup) {
			const branches = model.setup.branches;
			// Keep the user's choice across re-renders while it is still valid.
			selection.base = branches.includes(selection.base) ? selection.base : model.setup.base;
			selection.head = branches.includes(selection.head) ? selection.head : model.setup.head;
			content.append(
				branchSelect('base', 'Base', branches, selection.base, 'base'),
				branchSelect('head', 'Head', branches, selection.head, 'head'),
			);
		}

		if (model.header) {
			content.append(element('div', { class: 'range', title: `Reviewing ${model.header.head} into ${model.header.base}` }, [
				element('span', { class: 'branch' }, [model.header.base]),
				'←',
				element('span', { class: 'branch' }, [model.header.head]),
			]));
		}

		if (model.notice) {
			content.append(element('p', { class: 'notice' }, [model.notice]));
		}

		if (model.rows.length > 0) {
			const list = element('ul', { class: 'commits' });
			for (const row of model.rows) {
				const mark = row.status === 'approved' ? '✓' : row.status === 'current' ? '▶' : '';
				list.append(element('li', { class: row.status, title: `${row.sha}\n${row.subject}` }, [
					element('span', { class: 'mark' }, [mark]),
					element('span', { class: 'sha' }, [row.shortSha]),
					element('span', { class: 'subject' }, [row.subject]),
				]));
			}
			content.append(list);
		}

		const children = [content];
		if (busy) {
			children.push(element('div', { class: 'busy' }, [`${model.busy}…`]));
		}
		if (model.buttons.length > 0) {
			children.push(element('div', { class: 'actions' }, model.buttons.map(spec => button(spec, busy))));
		}
		if (model.overlay) {
			children.push(element('div', { class: 'overlay', role: 'alertdialog' }, [
				element('h2', {}, [model.overlay.title]),
				element('p', {}, [model.overlay.message]),
				button(model.overlay.button, busy),
			]));
		}
		root.replaceChildren(...children);
		vscode.setState(selection);
	}

	window.addEventListener('message', event => {
		if (event.data?.type === 'model') {
			render(event.data.model);
		}
	});
	vscode.postMessage({ type: 'ready' });
})();
