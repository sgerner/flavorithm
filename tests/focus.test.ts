import test from 'node:test';
import assert from 'node:assert/strict';
import {
	FOCUSABLE_SELECTOR,
	busyAction,
	focusHandoff,
	focusTrap,
	getFocusableControls
} from '../src/lib/focus.ts';

type ListenerRecord = {
	type: string;
	listener: (event: any) => void;
	capture: boolean;
};

class FakeElement {
	tagName: string;
	id = '';
	type = '';
	tabIndex = 0;
	inert = false;
	isConnected = true;
	offsetParent: object | null = {};
	style: Record<string, string> = { display: 'block', visibility: 'visible', overflow: '' };
	parentElement: FakeElement | null = null;
	children: FakeElement[] = [];
	attributes = new Map<string, string>();
	classList: string[] = [];
	listeners: ListenerRecord[] = [];
	ownerDoc: FakeDocument;

	constructor(doc: FakeDocument, tagName: string, opts: Partial<FakeElement> = {}) {
		this.ownerDoc = doc;
		this.tagName = tagName.toUpperCase();
		if (
			!['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'A'].includes(this.tagName) &&
			opts.tabIndex === undefined
		) {
			this.tabIndex = -1;
		}
		Object.assign(this, opts);
	}

	append(...nodes: FakeElement[]) {
		for (const child of nodes) {
			child.parentElement = this;
			child.setConnected(this.isConnected);
			this.children.push(child);
		}
		return this;
	}

	remove() {
		const active = this.ownerDoc.activeElement;
		const removingActive = Boolean(active && (active === this || this.contains(active)));
		if (removingActive && active) {
			// Match Chromium/Blink ContainerNode::WillRemoveChild: focusout fires with
			// relatedTarget: null BEFORE isConnected flips to false.
			this.ownerDoc.activeElement = this.ownerDoc.body;
			active.dispatch({ type: 'focusout', relatedTarget: null, bubbles: true });
		}
		if (this.parentElement) {
			this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
			this.parentElement = null;
		}
		this.setConnected(false);
	}

	setConnected(connected: boolean) {
		this.isConnected = connected;
		for (const child of this.children) child.setConnected(connected);
	}

	contains(target: FakeElement | null): boolean {
		let cur = target;
		while (cur) {
			if (cur === this) return true;
			cur = cur.parentElement;
		}
		return false;
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
		if (name === 'tabindex') this.tabIndex = Number(value);
		if (name === 'id') this.id = value;
		if (name === 'inert') this.inert = true;
	}

	getAttribute(name: string): string | null {
		if (name === 'id' && this.id) return this.id;
		if (name === 'type' && this.type) return this.type;
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string) {
		this.attributes.delete(name);
		if (name === 'inert') this.inert = false;
	}

	hasAttribute(name: string): boolean {
		if (name === 'inert' && this.inert) return true;
		return this.attributes.has(name);
	}

	focus() {
		if (!this.isConnected || this.hasAttribute('disabled') || this.closest('[inert]')) return;
		const previous = this.ownerDoc.activeElement;
		if (previous === this) return;
		this.ownerDoc.activeElement = this;
		if (previous && previous !== this.ownerDoc.body) {
			previous.dispatch({ type: 'focusout', relatedTarget: this, bubbles: true });
		}
		this.dispatch({ type: 'focusin', relatedTarget: previous, bubbles: true });
	}

	getClientRects() {
		return this.offsetParent ? [{}] : [];
	}

	matches(selector: string): boolean {
		return selector
			.split(',')
			.map((s) => s.trim())
			.some((part) => this.matchesSingle(part));
	}

	private matchesSingle(raw: string): boolean {
		let sel = raw.trim();
		if (!sel) return false;
		if (sel.startsWith(':scope > ')) {
			sel = sel.slice(':scope > '.length).trim();
		}
		while (sel.includes(':not(')) {
			const start = sel.indexOf(':not(');
			const end = sel.indexOf(')', start);
			if (end === -1) break;
			const inner = sel.slice(start + 5, end);
			if (this.matchesSingle(inner)) return false;
			sel = sel.slice(0, start) + sel.slice(end + 1);
		}
		const attrRegex = /\[([^\]=]+)(?:="([^"]*)")?\]/g;
		let attrMatch: RegExpExecArray | null;
		while ((attrMatch = attrRegex.exec(sel)) !== null) {
			const [, attrName, attrVal] = attrMatch;
			if (attrName === 'tabindex') {
				const explicit = this.attributes.get('tabindex');
				if (explicit === undefined) return false;
				if (attrVal !== undefined && explicit !== attrVal) return false;
			} else if (attrVal !== undefined) {
				if (this.getAttribute(attrName) !== attrVal) return false;
			} else if (!this.hasAttribute(attrName)) {
				return false;
			}
		}
		sel = sel.replace(/\[[^\]]+\]/g, '');
		if (sel.startsWith('#')) {
			return this.id === sel.slice(1);
		}
		const [tagPart, ...classes] = sel.split('.');
		if (tagPart && tagPart !== '*' && this.tagName !== tagPart.toUpperCase()) {
			return false;
		}
		for (const cls of classes) {
			const unescaped = cls.replace(/\\/g, '');
			if (unescaped && !this.classList.includes(unescaped)) return false;
		}
		return true;
	}

	closest(selector: string): FakeElement | null {
		let cur: FakeElement | null = this;
		while (cur) {
			if (cur.matches(selector)) return cur;
			cur = cur.parentElement;
		}
		return null;
	}

	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		const trimmed = selector.trim();
		if (trimmed.startsWith(':scope > ')) {
			const childSel = trimmed.slice(':scope > '.length).trim();
			return this.children.filter((c) => c.matches(childSel));
		}
		const results: FakeElement[] = [];
		const visit = (parent: FakeElement) => {
			for (const child of parent.children) {
				if (selector.includes(' ') && !selector.includes(',')) {
					const [ancestorSel, leafSel] = selector.split(/\s+/, 2);
					if (child.matches(leafSel) && child.parentElement?.closest(ancestorSel)) {
						results.push(child);
					}
				} else if (child.matches(selector)) {
					results.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return results;
	}

	addEventListener(
		type: string,
		listener: (event: any) => void,
		options?: boolean | { capture?: boolean }
	) {
		const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
		this.listeners.push({ type, listener, capture });
	}

	removeEventListener(
		type: string,
		listener: (event: any) => void,
		options?: boolean | { capture?: boolean }
	) {
		const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
		this.listeners = this.listeners.filter(
			(item) => !(item.type === type && item.listener === listener && item.capture === capture)
		);
	}

	dispatch(init: {
		type: string;
		key?: string;
		shiftKey?: boolean;
		bubbles?: boolean;
		submitter?: FakeElement | null;
		relatedTarget?: FakeElement | null;
	}) {
		let stopped = false;
		let immediateStopped = false;
		const event = {
			...init,
			defaultPrevented: false,
			target: this,
			currentTarget: this as FakeElement,
			preventDefault() {
				this.defaultPrevented = true;
			},
			stopPropagation() {
				stopped = true;
			},
			stopImmediatePropagation() {
				stopped = true;
				immediateStopped = true;
			}
		};

		const chain: FakeElement[] = [];
		let cur: FakeElement | null = this;
		while (cur) {
			chain.push(cur);
			cur = init.bubbles === false ? null : cur.parentElement;
		}

		for (const node of [...chain].reverse()) {
			if (stopped) break;
			event.currentTarget = node;
			for (const rec of [...node.listeners]) {
				if (!rec.capture || rec.type !== init.type) continue;
				rec.listener(event);
				if (immediateStopped) break;
			}
		}

		for (const node of chain) {
			if (stopped) break;
			event.currentTarget = node;
			for (const rec of [...node.listeners]) {
				if (rec.capture || rec.type !== init.type) continue;
				rec.listener(event);
				if (immediateStopped) break;
			}
		}

		return event;
	}
}

class FakeDocument {
	documentElement: FakeElement;
	body: FakeElement;
	activeElement: FakeElement;

	constructor() {
		this.documentElement = new FakeElement(this, 'html', { tabIndex: -1 });
		this.body = new FakeElement(this, 'body', { tabIndex: -1 });
		this.documentElement.append(this.body);
		this.activeElement = this.body;
	}

	el(tagName: string, opts: Partial<FakeElement> = {}) {
		return new FakeElement(this, tagName, opts);
	}

	getElementById(id: string): FakeElement | null {
		return this.body.querySelector(`#${id}`);
	}

	querySelectorAll(selector: string): FakeElement[] {
		return this.body.querySelectorAll(selector);
	}
}

async function flushMicrotasks(turns = 3) {
	for (let i = 0; i < turns; i++) {
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	}
}

function installFakeDOM(t: test.TestContext) {
	const doc = new FakeDocument();
	const win = {
		getComputedStyle(el: FakeElement) {
			return el.style;
		}
	};
	const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
	Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
	t.after(() => {
		if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
		else Reflect.deleteProperty(globalThis, 'document');
		if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
		else Reflect.deleteProperty(globalThis, 'window');
	});
	return doc;
}

test('focusTrap preserves originalFocus across synchronous zero-duration modal swaps', async (t) => {
	const doc = installFakeDOM(t);
	const main = doc.el('main', { id: 'kitchen-content', tabIndex: -1 });
	const trigger = doc.el('button', { classList: ['recipe-title'] });
	main.append(trigger);
	doc.body.append(main);
	trigger.focus();

	const detailDialog = doc.el('div', { tabIndex: -1 });
	detailDialog.setAttribute('role', 'dialog');
	const editBtn = doc.el('button');
	detailDialog.append(editBtn);
	doc.body.append(detailDialog);

	const trap1 = focusTrap(detailDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, editBtn);
	assert.equal(doc.body.style.overflow, 'hidden');

	// Simulate prefers-reduced-motion: outgoing dialog unmounts synchronously before incoming mounts.
	detailDialog.remove();
	trap1.destroy();
	assert.equal(doc.activeElement, doc.body);

	const editorDialog = doc.el('div', { tabIndex: -1 });
	editorDialog.setAttribute('role', 'dialog');
	const cancelBtn = doc.el('button');
	editorDialog.append(cancelBtn);
	doc.body.append(editorDialog);

	const trap2 = focusTrap(editorDialog as unknown as HTMLElement);
	await flushMicrotasks();
	assert.equal(doc.activeElement, cancelBtn);
	assert.equal(doc.body.style.overflow, 'hidden');

	// Closing the chained dialog restores focus to the original trigger, not document.body.
	editorDialog.remove();
	trap2.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, trigger);
	assert.equal(doc.body.style.overflow, '');
});

test('focusTrap resolves neighbor card or #kitchen-content when trigger unmounts after deletion', async (t) => {
	const doc = installFakeDOM(t);
	const main = doc.el('main', { id: 'kitchen-content', tabIndex: -1 });
	const grid = doc.el('div', { classList: ['recipe-grid'] });

	const card1 = doc.el('article', { classList: ['recipe-card'] });
	const open1 = doc.el('button', { classList: ['recipe-title'] });
	card1.append(open1);

	const card2 = doc.el('article', { classList: ['recipe-card'] });
	const open2 = doc.el('button', { classList: ['recipe-title'] });
	card2.append(open2);

	grid.append(card1, card2);
	main.append(grid);
	doc.body.append(main);

	open1.focus();
	// Simulate Svelte setting inert on .app-shell in render_effect before focusTrap mounts
	main.inert = true;
	const deleteDialog = doc.el('div', { tabIndex: -1 });
	deleteDialog.setAttribute('role', 'dialog');
	const confirmBtn = doc.el('button');
	deleteDialog.append(confirmBtn);
	doc.body.append(deleteDialog);

	const trap1 = focusTrap(deleteDialog as unknown as HTMLElement);
	await flushMicrotasks();

	// Delete card1, lift inert on main, and close dialog: focus moves to neighbor card2's .recipe-title button.
	card1.remove();
	main.inert = false;
	deleteDialog.remove();
	trap1.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, open2);

	// Now delete the last remaining card2: focus falls back to #kitchen-content landmark.
	const dialog2 = doc.el('div', { tabIndex: -1 });
	dialog2.setAttribute('role', 'dialog');
	dialog2.append(doc.el('button'));
	doc.body.append(dialog2);
	const trap2 = focusTrap(dialog2 as unknown as HTMLElement);
	await flushMicrotasks();

	card2.remove();
	dialog2.remove();
	trap2.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, main);
});

test('focusTrap includes summary and positive/zero tabindex controls in Tab cycle and invokes onEscape', async (t) => {
	const doc = installFakeDOM(t);
	assert.ok(FOCUSABLE_SELECTOR.includes('summary'));
	assert.ok(FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));

	const dialog = doc.el('div', { tabIndex: -1 });
	dialog.setAttribute('role', 'dialog');
	const closeBtn = doc.el('button');
	const details = doc.el('details');
	const summary = doc.el('summary');
	const hiddenInput = doc.el('input');
	details.append(summary, hiddenInput);
	const customTab = doc.el('div');
	customTab.setAttribute('tabindex', '0');
	const skippedOption = doc.el('button');
	skippedOption.setAttribute('tabindex', '-1');

	dialog.append(closeBtn, details, customTab, skippedOption);
	doc.body.append(dialog);

	let escaped = 0;
	const trap = focusTrap(dialog as unknown as HTMLElement, {
		onEscape: () => {
			escaped++;
		}
	});
	await flushMicrotasks();

	// Closed <details> includes <summary> and excludes hiddenInput; tabindex="-1" is excluded.
	const closedControls = getFocusableControls(dialog as unknown as ParentNode);
	assert.deepEqual(closedControls, [closeBtn, summary, customTab]);

	// Forward Tab from last control wraps to first; Shift+Tab from first wraps to last.
	customTab.focus();
	const tabForward = customTab.dispatch({
		type: 'keydown',
		key: 'Tab',
		shiftKey: false,
		bubbles: true
	});
	assert.equal(tabForward.defaultPrevented, true);
	assert.equal(doc.activeElement, closeBtn);

	const tabBackward = closeBtn.dispatch({
		type: 'keydown',
		key: 'Tab',
		shiftKey: true,
		bubbles: true
	});
	assert.equal(tabBackward.defaultPrevented, true);
	assert.equal(doc.activeElement, customTab);

	// Opening <details> exposes hiddenInput in the Tab cycle.
	details.setAttribute('open', '');
	const openControls = getFocusableControls(dialog as unknown as ParentNode);
	assert.deepEqual(openControls, [closeBtn, summary, hiddenInput, customTab]);

	// Escape calls onEscape and prevents default.
	const escEvent = summary.dispatch({ type: 'keydown', key: 'Escape', bubbles: true });
	assert.equal(escaped, 1);
	assert.equal(escEvent.defaultPrevented, true);

	trap.destroy();
	await flushMicrotasks();
});

test('busyAction toggles aria-disabled and blocks duplicate click, keydown, and form submit', () => {
	const doc = new FakeDocument();
	const form = doc.el('form');
	const submitBtn = doc.el('button', { type: 'submit' });
	form.append(submitBtn);
	doc.body.append(form);

	let clicks = 0;
	let submits = 0;
	submitBtn.addEventListener('click', () => {
		clicks++;
	});
	form.addEventListener('submit', () => {
		submits++;
	});

	const guard = busyAction(submitBtn as unknown as HTMLElement, false);
	assert.equal(submitBtn.getAttribute('aria-disabled'), null);

	submitBtn.dispatch({ type: 'click', bubbles: true });
	form.dispatch({ type: 'submit', submitter: submitBtn, bubbles: true });
	assert.equal(clicks, 1);
	assert.equal(submits, 1);

	guard.update(true);
	assert.equal(submitBtn.getAttribute('aria-disabled'), 'true');

	const blockedClick = submitBtn.dispatch({ type: 'click', bubbles: true });
	const blockedEnter = submitBtn.dispatch({ type: 'keydown', key: 'Enter', bubbles: true });
	const allowedTab = submitBtn.dispatch({ type: 'keydown', key: 'Tab', bubbles: true });
	const blockedSubmit = form.dispatch({ type: 'submit', submitter: submitBtn, bubbles: true });

	assert.equal(blockedClick.defaultPrevented, true);
	assert.equal(blockedEnter.defaultPrevented, true);
	assert.equal(allowedTab.defaultPrevented, false);
	assert.equal(blockedSubmit.defaultPrevented, true);
	assert.equal(clicks, 1);
	assert.equal(submits, 1);

	guard.update(false);
	assert.equal(submitBtn.getAttribute('aria-disabled'), null);
	submitBtn.dispatch({ type: 'click', bubbles: true });
	assert.equal(clicks, 2);

	guard.destroy();
});

test('focusHandoff moves focus on paired Edit/Done toggle, inert row deletion, and async unmount', async (t) => {
	const doc = installFakeDOM(t);
	const main = doc.el('main', { id: 'kitchen-content', tabIndex: -1 });
	const list = doc.el('div');
	const addInput = doc.el('input', { classList: ['add-shopping'] });
	main.append(list, addInput);
	doc.body.append(main);

	// 1. Shopping Edit -> input.shopping-name -> Done -> Edit
	const row1 = doc.el('div', { classList: ['shopping-row'] });
	const editBtn = doc.el('button', { classList: ['edit-btn'] });
	const remove1 = doc.el('button', { classList: ['icon-button'] });
	row1.append(editBtn, remove1);

	const row2 = doc.el('div', { classList: ['shopping-row'] });
	const remove2 = doc.el('button', { classList: ['icon-button'] });
	row2.append(remove2);
	list.append(row1, row2);

	const editHandoff = focusHandoff(editBtn as unknown as HTMLElement, {
		within: '.shopping-row',
		target: 'input.shopping-name'
	});
	editBtn.focus();
	editBtn.dispatch({ type: 'click', bubbles: true });
	editBtn.remove();
	editHandoff.destroy();
	const nameInput = doc.el('input', { classList: ['shopping-name'] });
	row1.children.unshift(nameInput);
	nameInput.parentElement = row1;
	await flushMicrotasks();
	assert.equal(doc.activeElement, nameInput);

	// 2. Deleting row1 when outgoing animation sets row1.inert = true focuses neighbor row2 remove button
	const remove1Handoff = focusHandoff(remove1 as unknown as HTMLElement, {
		row: '.shopping-row',
		target: ':scope > .icon-button',
		fallback: 'input.add-shopping'
	});
	remove1.focus();
	remove1.dispatch({ type: 'click', bubbles: true });
	row1.inert = true;
	doc.activeElement = doc.body;
	await flushMicrotasks();
	assert.equal(doc.activeElement, remove2);
	remove1Handoff.destroy();

	// 3. Deleting last row2 focuses fallback addInput
	row1.remove();
	const remove2Handoff = focusHandoff(remove2 as unknown as HTMLElement, {
		row: '.shopping-row',
		target: ':scope > .icon-button',
		fallback: 'input.add-shopping'
	});
	remove2.focus();
	remove2.dispatch({ type: 'click', bubbles: true });
	row2.remove();
	remove2Handoff.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, addInput);

	// 4. Async unmount without click (e.g., ButlerChat Stop reply finishing) focuses #butler-message
	const chatDialog = doc.el('div', { id: 'butler-panel', tabIndex: -1 });
	chatDialog.setAttribute('role', 'dialog');
	const messageBox = doc.el('textarea', { id: 'butler-message' });
	const stopBtn = doc.el('button');
	chatDialog.append(messageBox, stopBtn);
	doc.body.append(chatDialog);

	const stopHandoff = focusHandoff(stopBtn as unknown as HTMLElement, {
		target: '#butler-message'
	});
	stopBtn.focus();
	stopBtn.remove();
	stopHandoff.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, messageBox);

	// 5. Banner dismiss button inside <main id="kitchen-content"> resolves scope-self fallback '#kitchen-content'
	const starterBanner = doc.el('div', { classList: ['starter-note'] });
	const dismissBanner = doc.el('button');
	starterBanner.append(dismissBanner);
	main.append(starterBanner);

	const bannerHandoff = focusHandoff(dismissBanner as unknown as HTMLElement, {
		fallback: '#kitchen-content'
	});
	dismissBanner.focus();
	dismissBanner.dispatch({ type: 'click', bubbles: true });
	starterBanner.remove();
	bannerHandoff.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, main);
});
