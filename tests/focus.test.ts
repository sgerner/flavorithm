import test from 'node:test';
import assert from 'node:assert/strict';
import { focusableControls, focusTrap } from '../src/lib/focus.ts';

type Listener = (event: any) => void;

class MockElement {
	tagName: string;
	attributes = new Map<string, string>();
	children: MockElement[] = [];
	parentElement: MockElement | null = null;
	listeners = new Map<string, Set<Listener>>();
	style: Record<string, string> = {
		overflow: '',
		display: 'block',
		visibility: 'visible',
		position: 'static'
	};
	hidden = false;
	inert = false;
	open = false;
	disabled = false;
	isConnected = true;
	scrollTop = 0;
	offsetParent: object | null = {};
	private doc: MockDocument;

	constructor(doc: MockDocument, tagName: string, attrs: Record<string, string> = {}) {
		this.doc = doc;
		this.tagName = tagName.toUpperCase();
		for (const [key, value] of Object.entries(attrs)) {
			this.attributes.set(key, value);
			if (key === 'open') this.open = true;
			if (key === 'disabled') this.disabled = true;
			if (key === 'hidden') this.hidden = true;
			if (key === 'inert') this.inert = true;
		}
	}

	append(...nodes: MockElement[]) {
		for (const node of nodes) {
			node.parentElement = this;
			this.children.push(node);
		}
		return this;
	}

	focus() {
		if (!this.isConnected || this.closest('[inert], [hidden]')) return;
		this.doc.activeElement = this;
	}

	contains(other: MockElement | null): boolean {
		let cur = other;
		while (cur) {
			if (cur === this) return true;
			cur = cur.parentElement;
		}
		return false;
	}

	closest(selector: string): MockElement | null {
		const parts = selector.split(',').map((s) => s.trim());
		let cur: MockElement | null = this;
		while (cur) {
			if (parts.some((part) => cur!.matches(part))) return cur;
			cur = cur.parentElement;
		}
		return null;
	}

	matches(selector: string): boolean {
		if (selector === '[inert]') return this.inert || this.attributes.has('inert');
		if (selector === '[hidden]') return this.hidden || this.attributes.has('hidden');
		if (selector === 'button:not([disabled])') return this.tagName === 'BUTTON' && !this.disabled;
		if (selector === 'a[href]') return this.tagName === 'A' && this.attributes.has('href');
		if (selector === 'input:not([disabled])') return this.tagName === 'INPUT' && !this.disabled;
		if (selector === 'select:not([disabled])') return this.tagName === 'SELECT' && !this.disabled;
		if (selector === 'textarea:not([disabled])')
			return this.tagName === 'TEXTAREA' && !this.disabled;
		if (selector === '[tabindex="0"]') return this.attributes.get('tabindex') === '0';
		if (selector === 'details > summary:first-of-type') {
			if (this.tagName !== 'SUMMARY' || this.parentElement?.tagName !== 'DETAILS') return false;
			const firstSummary = this.parentElement.children.find((child) => child.tagName === 'SUMMARY');
			return firstSummary === this;
		}
		return false;
	}

	querySelectorAll(selector: string): MockElement[] {
		const parts = selector.split(',').map((s) => s.trim());
		const results: MockElement[] = [];
		const visit = (el: MockElement) => {
			for (const child of el.children) {
				if (parts.some((part) => child.matches(part))) results.push(child);
				visit(child);
			}
		};
		visit(this);
		return results;
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
		if (name === 'inert') this.inert = true;
		if (name === 'hidden') this.hidden = true;
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string) {
		this.attributes.delete(name);
		if (name === 'inert') this.inert = false;
		if (name === 'hidden') this.hidden = false;
	}

	addEventListener(type: string, listener: Listener) {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: Listener) {
		this.listeners.get(type)?.delete(listener);
	}

	dispatchEvent(event: { type: string; target?: unknown; [key: string]: unknown }) {
		event.target ??= this;
		for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
			listener(event);
		}
	}
}

class MockDocument {
	body: MockElement;
	documentElement: MockElement;
	activeElement: MockElement | null = null;

	constructor() {
		this.documentElement = new MockElement(this, 'html');
		this.body = new MockElement(this, 'body');
		this.documentElement.append(this.body);
		this.activeElement = this.body;
	}

	el(tag: string, attrs: Record<string, string> = {}) {
		return new MockElement(this, tag, attrs);
	}
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

function withMockDOM(run: (doc: MockDocument) => Promise<void> | void) {
	return async () => {
		const prevDoc = (globalThis as any).document;
		const prevWin = (globalThis as any).window;
		const prevObserver = (globalThis as any).MutationObserver;
		const doc = new MockDocument();
		(globalThis as any).document = doc;
		(globalThis as any).window = {
			getComputedStyle: (el: MockElement) => el.style
		};
		delete (globalThis as any).MutationObserver;
		try {
			await run(doc);
		} finally {
			(globalThis as any).document = prevDoc;
			(globalThis as any).window = prevWin;
			if (prevObserver !== undefined) (globalThis as any).MutationObserver = prevObserver;
		}
	};
}

function tabEvent(shiftKey = false) {
	let prevented = false;
	return {
		type: 'keydown',
		key: 'Tab',
		shiftKey,
		get defaultPrevented() {
			return prevented;
		},
		preventDefault() {
			prevented = true;
		}
	};
}

test(
	'focusableControls includes visible summary disclosures and skips closed details children',
	withMockDOM(async (doc) => {
		const dialog = doc.el('div', { 'aria-modal': 'true' });
		const closeBtn = doc.el('button');
		const closedDetails = doc.el('details');
		const closedSummary = doc.el('summary');
		const hiddenSelect = doc.el('select');
		const hiddenInput = doc.el('input');
		closedDetails.append(closedSummary, hiddenSelect, hiddenInput);

		const openDetails = doc.el('details', { open: '' });
		const openSummary = doc.el('summary');
		const visibleInput = doc.el('input');
		openDetails.append(openSummary, visibleInput);

		const saveBtn = doc.el('button');
		dialog.append(closeBtn, closedDetails, openDetails, saveBtn);
		doc.body.append(dialog);

		assert.deepEqual(focusableControls(dialog as unknown as HTMLElement), [
			closeBtn,
			closedSummary,
			openSummary,
			visibleInput,
			saveBtn
		]);

		const trigger = doc.el('button');
		doc.body.append(trigger);
		trigger.focus();

		const trap = focusTrap(dialog as unknown as HTMLElement);
		await flushMicrotasks();
		assert.equal(doc.activeElement, closeBtn);

		// Shift+Tab from first wraps to saveBtn; if saveBtn is hidden, wraps to closedSummary when it is last
		saveBtn.hidden = true;
		openDetails.hidden = true;
		const backWrap = tabEvent(true);
		dialog.dispatchEvent(backWrap);
		assert.equal(backWrap.defaultPrevented, true);
		assert.equal(doc.activeElement, closedSummary);

		const forwardWrap = tabEvent(false);
		dialog.dispatchEvent(forwardWrap);
		assert.equal(forwardWrap.defaultPrevented, true);
		assert.equal(doc.activeElement, closeBtn);

		trap.destroy();
		await flushMicrotasks();
	})
);

test(
	'focusTrap deactivates on outrostart, unlocks scroll immediately, and never steals focus during 300ms outro',
	withMockDOM(async (doc) => {
		const trigger = doc.el('button');
		const pageInput = doc.el('input');
		const dialog = doc.el('div', { 'aria-modal': 'true' });
		const closeBtn = doc.el('button');
		dialog.append(closeBtn);
		doc.body.append(trigger, pageInput, dialog);

		trigger.focus();
		const trap = focusTrap(dialog as unknown as HTMLElement);
		await flushMicrotasks();
		assert.equal(doc.body.style.overflow, 'hidden');
		assert.equal(doc.activeElement, closeBtn);

		// Child transition outrostart must NOT deactivate parent dialog trap
		const child = doc.el('span');
		dialog.append(child);
		dialog.dispatchEvent({ type: 'outrostart', target: child });
		assert.equal(doc.body.style.overflow, 'hidden');
		assert.equal(dialog.getAttribute('aria-modal'), 'true');

		// Dialog outrostart deactivates immediately before destroy()
		dialog.dispatchEvent({ type: 'outrostart', target: dialog });
		assert.equal(doc.body.style.overflow, '');
		assert.equal(dialog.getAttribute('aria-modal'), null);
		await flushMicrotasks();
		assert.equal(doc.activeElement, trigger);

		// User focuses a page input during the 300ms exit transition
		pageInput.focus();
		assert.equal(doc.activeElement, pageInput);

		// Unmount after 300ms must retain focus on pageInput
		trap.destroy();
		await flushMicrotasks();
		assert.equal(doc.activeElement, pageInput);
		assert.equal(doc.body.style.overflow, '');
	})
);

test(
	'switching modals and opening a dialog from a mobile drawer keep one active modal and skip intermediate focus return',
	withMockDOM(async (doc) => {
		const menuBtn = doc.el('button');
		const drawer = doc.el('aside');
		const drawerClose = doc.el('button');
		const settingsTrigger = doc.el('button');
		drawer.append(drawerClose, settingsTrigger);
		doc.body.append(menuBtn, drawer);

		// Desktop (>650px): drawer starts disabled / non-modal
		const drawerTrap = focusTrap(drawer as unknown as HTMLElement, {
			enabled: false,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		assert.equal(doc.body.style.overflow, '');

		// Narrow screen: open drawer
		menuBtn.focus();
		drawerTrap.update({
			enabled: true,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		await flushMicrotasks();
		assert.equal(doc.activeElement, drawerClose);
		assert.equal(doc.body.style.overflow, 'hidden');

		// Close drawer directly -> restores focus to menuBtn
		drawerTrap.update({
			enabled: false,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		await flushMicrotasks();
		assert.equal(doc.activeElement, menuBtn);
		assert.equal(doc.body.style.overflow, '');

		// Reopen drawer, then click Settings (closes drawer + opens modal synchronously)
		drawerTrap.update({
			enabled: true,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		await flushMicrotasks();
		settingsTrigger.focus();

		const modal1 = doc.el('div', { 'aria-modal': 'true' });
		const modal1Close = doc.el('button');
		modal1.append(modal1Close);
		doc.body.append(modal1);

		// Simulate shell becoming inert while modal opens and drawer closes
		menuBtn.inert = true;
		drawerTrap.update({
			enabled: false,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		const trap1 = focusTrap(modal1 as unknown as HTMLElement, { key: 'settings' });
		await flushMicrotasks();

		// Focus moved into modal1, NOT menuBtn
		assert.equal(doc.activeElement, modal1Close);
		assert.equal(doc.body.style.overflow, 'hidden');

		// Switch directly to a second modal instance while modal1 becomes inert for outro
		modal1.inert = true;
		const modal2 = doc.el('div', { 'aria-modal': 'true' });
		const modal2Close = doc.el('button');
		modal2.append(modal2Close);
		doc.body.append(modal2);
		const trap2 = focusTrap(modal2 as unknown as HTMLElement, { key: 'delete' });
		await flushMicrotasks();

		const activeModals = [modal1, modal2].filter((el) => el.getAttribute('aria-modal') === 'true');
		assert.equal(activeModals.length, 1);
		assert.equal(activeModals[0], modal2);
		assert.equal(doc.activeElement, modal2Close);

		// Late outro/destroy of modal1 does not disrupt modal2
		trap1.destroy();
		await flushMicrotasks();
		assert.equal(doc.activeElement, modal2Close);
		assert.equal(doc.body.style.overflow, 'hidden');

		// Closing modal2 un-inerts shell and restores focus to original menuBtn trigger
		menuBtn.inert = false;
		modal2.dispatchEvent({ type: 'outrostart', target: modal2 });
		await flushMicrotasks();
		assert.equal(doc.activeElement, menuBtn);
		assert.equal(doc.body.style.overflow, '');

		trap2.destroy();
		drawerTrap.destroy();
	})
);
