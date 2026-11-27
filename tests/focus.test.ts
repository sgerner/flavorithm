import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as svelte from 'svelte';
import * as svelteAnimate from 'svelte/animate';
import { compile } from 'svelte/compiler';
import ts from 'typescript';
import * as aiConnectionsMod from '../src/lib/ai-connections.ts';
import * as aiContinuationMod from '../src/lib/ai-continuation.ts';
import * as butlerActionsMod from '../src/lib/butler-actions.ts';
import * as butlerChatMod from '../src/lib/butler-chat.ts';
import * as butlerMod from '../src/lib/butler.ts';
import * as syncMod from '../src/lib/client-sync.ts';
import * as clientWorkflowsMod from '../src/lib/client-workflows.ts';
import * as coverUploadMod from '../src/lib/cover-upload.ts';
import * as dataMod from '../src/lib/data.ts';
import * as discoveryMod from '../src/lib/discovery.ts';
import * as domainMod from '../src/lib/domain.ts';
import {
	HANDOFF_FOCUSABLE_SELECTOR,
	busyAction,
	focusHandoff,
	focusTrap,
	getFocusableControls,
	isFocusable
} from '../src/lib/focus.ts';
import * as focusMod from '../src/lib/focus.ts';
import * as formValidationMod from '../src/lib/form-validation.ts';
import * as guestMod from '../src/lib/guest-storage.ts';
import * as importSessionMod from '../src/lib/import-session.ts';
import * as kitchenExportMod from '../src/lib/kitchen-export.ts';
import * as workflowsMod from '../src/lib/kitchen-workflows.ts';
import * as plannerMod from '../src/lib/planner.ts';
import * as recipeCollectionMod from '../src/lib/recipe-collection.ts';
import * as coverMod from '../src/lib/recipe-cover.ts';
import * as recipeDetailMod from '../src/lib/recipe-detail.ts';
import * as recipeDraftMod from '../src/lib/recipe-draft.ts';
import * as scraperMod from '../src/lib/recipe-scraper.ts';
import type { AppState, Recipe } from '../src/lib/types.ts';
import * as voiceCaptureMod from '../src/lib/voice-capture.ts';
import * as voiceConfigMod from '../src/lib/voice-config.ts';

const nodeRequire = createRequire(import.meta.url);
const svelteClient = nodeRequire('svelte/internal/client') as {
	effect_root: (fn: () => void) => () => void;
};
const svelteServer = nodeRequire('svelte/internal/server') as Record<string, unknown>;

type ListenerRecord = {
	type: string;
	listener: (event: any) => void;
	capture: boolean;
};

function splitTopLevelCommas(selector: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < selector.length; i++) {
		const ch = selector[i];
		if (ch === '(' || ch === '[') depth += 1;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (ch === ',' && depth === 0) {
			parts.push(selector.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(selector.slice(start).trim());
	return parts.filter(Boolean);
}

type SelectorStep = {
	combinator: 'descendant' | 'child';
	compound: string;
};

function tokenizeSelectorSteps(singleSelector: string): SelectorStep[] {
	const steps: SelectorStep[] = [];
	let depth = 0;
	let buf = '';
	let nextCombinator: 'descendant' | 'child' = 'descendant';

	const flush = () => {
		const trimmed = buf.trim();
		if (trimmed) {
			steps.push({ combinator: nextCombinator, compound: trimmed });
			nextCombinator = 'descendant';
		}
		buf = '';
	};

	for (let i = 0; i < singleSelector.length; i++) {
		const ch = singleSelector[i];
		if (ch === '(' || ch === '[') {
			depth += 1;
			buf += ch;
		} else if (ch === ')' || ch === ']') {
			depth = Math.max(0, depth - 1);
			buf += ch;
		} else if (depth === 0 && ch === '>') {
			flush();
			nextCombinator = 'child';
		} else if (depth === 0 && /\s/.test(ch)) {
			flush();
		} else {
			buf += ch;
		}
	}
	flush();
	return steps;
}

class FakeElement {
	tagName: string;
	id = '';
	type = '';
	tabIndex = 0;
	hidden = false;
	open = false;
	scrollTop = 0;
	isConnected = true;
	offsetParent: object | null = {};
	style: Record<string, string> = { display: 'block', visibility: 'visible', overflow: '' };
	parentElement: FakeElement | null = null;
	children: FakeElement[] = [];
	attributes = new Map<string, string>();
	classList: string[] = [];
	listeners: ListenerRecord[] = [];
	lastFocusOptions: { preventScroll?: boolean } | undefined;
	ownerDoc: FakeDocument;
	private _inert = false;

	constructor(doc: FakeDocument, tagName: string, opts: Partial<FakeElement> = {}) {
		this.ownerDoc = doc;
		this.tagName = tagName.toUpperCase();
		if (
			!['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) &&
			opts.tabIndex === undefined
		) {
			this.tabIndex = -1;
		}
		Object.assign(this, opts);
	}

	get inert(): boolean {
		return this._inert;
	}

	set inert(value: boolean) {
		const next = Boolean(value);
		this._inert = next;
		if (next) this.attributes.set('inert', '');
		else this.attributes.delete('inert');
	}

	append(...nodes: FakeElement[]) {
		for (const child of nodes) {
			child.parentElement = this;
			if (this.tagName === 'DETAILS' && child.tagName === 'SUMMARY') {
				const firstSummary =
					this.children.find((existing) => existing.tagName === 'SUMMARY') ?? child;
				if (firstSummary === child && !child.attributes.has('tabindex')) {
					child.tabIndex = 0;
				}
			}
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
		if (name === 'hidden') this.hidden = true;
		if (name === 'open') this.open = true;
		if (name === 'inert') this._inert = true;
	}

	getAttribute(name: string): string | null {
		if (name === 'id' && this.id) return this.id;
		if (name === 'type' && this.type) return this.type;
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string) {
		this.attributes.delete(name);
		if (name === 'hidden') this.hidden = false;
		if (name === 'open') this.open = false;
		if (name === 'inert') this._inert = false;
	}

	hasAttribute(name: string): boolean {
		if (name === 'inert' && this._inert) return true;
		if (name === 'hidden' && this.hidden) return true;
		if (name === 'open' && this.open) return true;
		return this.attributes.has(name);
	}

	focus(options?: { preventScroll?: boolean }) {
		if (!this.isConnected || this.hasAttribute('disabled') || this.closest('[inert]')) return;
		if (this.tagName === 'SUMMARY' && !this.hasAttribute('tabindex')) {
			const firstSummary =
				this.parentElement?.tagName === 'DETAILS'
					? this.parentElement.children.find((child) => child.tagName === 'SUMMARY')
					: null;
			if (firstSummary !== this) return;
		}
		this.lastFocusOptions = options;
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

	matches(selector: string, scopeRoot?: FakeElement): boolean {
		return splitTopLevelCommas(selector).some((part) => this.matchesChain(part, scopeRoot));
	}

	private matchesChain(selector: string, scopeRoot?: FakeElement): boolean {
		const steps = tokenizeSelectorSteps(selector);
		if (!steps.length) return false;
		return this.matchStepIndex(steps, steps.length - 1, scopeRoot);
	}

	private matchStepIndex(steps: SelectorStep[], index: number, scopeRoot?: FakeElement): boolean {
		const step = steps[index];
		if (!this.matchesCompound(step.compound, scopeRoot)) return false;
		if (index === 0) return true;
		const prevCombinator = step.combinator;
		if (prevCombinator === 'child') {
			return Boolean(
				this.parentElement && this.parentElement.matchStepIndex(steps, index - 1, scopeRoot)
			);
		}
		let ancestor = this.parentElement;
		while (ancestor) {
			if (ancestor.matchStepIndex(steps, index - 1, scopeRoot)) return true;
			ancestor = ancestor.parentElement;
		}
		return false;
	}

	private matchesCompound(raw: string, scopeRoot?: FakeElement): boolean {
		let sel = raw.trim();
		if (!sel) return false;
		if (sel === ':scope') return scopeRoot ? this === scopeRoot : true;

		while (sel.includes(':not(')) {
			const start = sel.indexOf(':not(');
			let depth = 1;
			let end = start + 5;
			while (end < sel.length && depth > 0) {
				if (sel[end] === '(') depth += 1;
				else if (sel[end] === ')') depth -= 1;
				end += 1;
			}
			const inner = sel.slice(start + 5, end - 1);
			if (this.matches(inner, scopeRoot)) return false;
			sel = sel.slice(0, start) + sel.slice(end);
		}

		if (sel.includes(':first-of-type')) {
			if (!this.parentElement) return false;
			const firstSameTag = this.parentElement.children.find((c) => c.tagName === this.tagName);
			if (firstSameTag !== this) return false;
			sel = sel.replaceAll(':first-of-type', '');
		}

		const nthChildMatch = sel.match(/:nth-child\((\d+)\)/);
		if (nthChildMatch) {
			if (!this.parentElement) return false;
			const expectedIdx = Number(nthChildMatch[1]) - 1;
			if (this.parentElement.children.indexOf(this) !== expectedIdx) return false;
			sel = sel.replace(/:nth-child\(\d+\)/g, '');
		}

		const attrRegex = /\[([^\]^=]+)(\^=|=)?"?([^"\]]*)"?\]/g;
		let attrMatch: RegExpExecArray | null;
		while ((attrMatch = attrRegex.exec(sel)) !== null) {
			const [, attrName, op, attrVal] = attrMatch;
			if (attrName === 'tabindex') {
				const explicit = this.attributes.get('tabindex');
				if (explicit === undefined) return false;
				if (op === '=' && explicit !== attrVal) return false;
			} else if (op === '^=') {
				const current = this.getAttribute(attrName);
				if (!current || !current.startsWith(attrVal)) return false;
			} else if (op === '=') {
				if (this.getAttribute(attrName) !== attrVal) return false;
			} else if (!this.hasAttribute(attrName)) {
				return false;
			}
		}
		sel = sel.replace(/\[[^\]]+\]/g, '');
		if (!sel) return true;
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
		const results: FakeElement[] = [];
		const visit = (parent: FakeElement) => {
			for (const child of parent.children) {
				if (child.matches(selector, this)) {
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

	querySelector(selector: string): FakeElement | null {
		return this.body.querySelector(selector);
	}

	querySelectorAll(selector: string): FakeElement[] {
		return this.body.querySelectorAll(selector);
	}
}

async function flushMicrotasks(turns = 4) {
	for (let i = 0; i < turns; i++) {
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	}
}

function installFakeDOM(t: test.TestContext) {
	const doc = new FakeDocument();
	let computedStyleCalls = 0;
	const win = {
		getComputedStyle(el: FakeElement) {
			computedStyleCalls += 1;
			return el.style;
		},
		matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
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
	return {
		doc,
		get computedStyleCalls() {
			return computedStyleCalls;
		},
		resetComputedStyleCalls() {
			computedStyleCalls = 0;
		}
	};
}

test('getFocusableControls matches details > summary:first-of-type and excludes bare, secondary, or closed-details controls', (t) => {
	const { doc } = installFakeDOM(t);
	assert.ok(
		HANDOFF_FOCUSABLE_SELECTOR.includes('details > summary:first-of-type:not([tabindex="-1"])')
	);
	assert.equal(/(?:^|,)summary:not/.test(HANDOFF_FOCUSABLE_SELECTOR), false);

	const container = doc.el('div', { tabIndex: -1 });
	const closeBtn = doc.el('button');
	const bareSummary = doc.el('summary');

	const details = doc.el('details');
	const firstSummary = doc.el('summary');
	const secondSummary = doc.el('summary');
	const hiddenInput = doc.el('input');
	details.append(firstSummary, secondSummary, hiddenInput);

	const customTab = doc.el('div');
	customTab.setAttribute('tabindex', '0');
	const skippedOption = doc.el('button');
	skippedOption.setAttribute('tabindex', '-1');

	container.append(closeBtn, bareSummary, details, customTab, skippedOption);
	doc.body.append(container);

	assert.equal(isFocusable(bareSummary as unknown as Element), false);
	assert.equal(isFocusable(secondSummary as unknown as Element), false);
	assert.equal(isFocusable(firstSummary as unknown as Element), true);

	assert.deepEqual(getFocusableControls(container as unknown as ParentNode), [
		closeBtn,
		firstSummary,
		customTab
	]);

	details.setAttribute('open', '');
	assert.deepEqual(getFocusableControls(container as unknown as ParentNode), [
		closeBtn,
		firstSummary,
		hiddenInput,
		customTab
	]);
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

test('focusHandoff computes neighbors lazily at unmount with zero getComputedStyle calls on focusin/click across 85 sites', async (t) => {
	const dom = installFakeDOM(t);
	const { doc } = dom;
	const main = doc.el('main', { id: 'kitchen-content', tabIndex: -1 });
	doc.body.append(main);

	const list = doc.el('div', { classList: ['pantry-list'] });
	main.append(list);
	const handoffs: Array<{ destroy: () => void }> = [];
	const removeButtons: FakeElement[] = [];

	for (let i = 0; i < 85; i++) {
		const row = doc.el('div', { classList: ['pantry-row'] });
		const edit = doc.el('button', { classList: ['pantry-edit-button'] });
		const restock = doc.el('button', { classList: ['restock-item'] });
		const remove = doc.el('button', { classList: ['pantry-remove-button'] });
		row.append(edit, restock, remove);
		list.append(row);
		removeButtons.push(remove);
		handoffs.push(
			focusHandoff(remove as unknown as HTMLElement, {
				row: '.pantry-row',
				target: '.pantry-remove-button',
				fallback: '#kitchen-content'
			})
		);
	}

	dom.resetComputedStyleCalls();
	const startMs = performance.now();
	for (const btn of removeButtons) {
		btn.focus();
		btn.dispatch({ type: 'click', bubbles: true });
	}
	const elapsedMs = performance.now() - startMs;

	assert.equal(dom.computedStyleCalls, 0);
	assert.ok(elapsedMs < 100, `Expected <100ms for 85 focusin+click cycles, took ${elapsedMs}ms`);
	await flushMicrotasks();

	dom.resetComputedStyleCalls();
	const targetBtn = removeButtons[10];
	targetBtn.focus();
	targetBtn.dispatch({ type: 'click', bubbles: true });
	assert.equal(dom.computedStyleCalls, 0);

	targetBtn.parentElement!.remove();
	handoffs[10].destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, removeButtons[11]);
	assert.ok(
		dom.computedStyleCalls <= 6,
		`Expected lazy neighbor check (<= 6 style reads), got ${dom.computedStyleCalls}`
	);

	const toolbar = doc.el('div', { classList: ['toolbar'] });
	const beforeBtn = doc.el('button', { classList: ['before-btn'] });
	const transientWrap = doc.el('span');
	const transientBtn = doc.el('button', { classList: ['transient-btn'] });
	transientWrap.append(transientBtn);
	const afterBtn = doc.el('button', { classList: ['after-btn'] });
	toolbar.append(beforeBtn, transientWrap, afterBtn);
	main.append(toolbar);

	const transientHandoff = focusHandoff(transientBtn as unknown as HTMLElement);
	transientBtn.focus();
	transientBtn.dispatch({ type: 'click', bubbles: true });
	transientWrap.remove();
	transientHandoff.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, afterBtn);

	const tailWrap = doc.el('span');
	const tailBtn = doc.el('button', { classList: ['tail-btn'] });
	tailWrap.append(tailBtn);
	toolbar.append(tailWrap);
	const tailHandoff = focusHandoff(tailBtn as unknown as HTMLElement);
	tailBtn.focus();
	tailWrap.remove();
	tailHandoff.destroy();
	await flushMicrotasks();
	assert.equal(doc.activeElement, afterBtn);

	const midBtn = doc.el('button', { classList: ['mid-btn'] });
	toolbar.children.splice(1, 0, midBtn);
	midBtn.parentElement = toolbar;
	const midHandoff = focusHandoff(midBtn as unknown as HTMLElement);
	midBtn.focus();
	midBtn.dispatch({ type: 'click', bubbles: true });
	const replacementBtn = doc.el('button', { classList: ['replacement-btn'] });
	const midIdx = toolbar.children.indexOf(midBtn);
	midBtn.remove();
	midHandoff.destroy();
	toolbar.children.splice(midIdx, 0, replacementBtn);
	replacementBtn.parentElement = toolbar;
	await flushMicrotasks();
	assert.equal(doc.activeElement, replacementBtn);

	for (const h of handoffs) h.destroy();
});

test('focusHandoff moves focus on paired Edit/Done toggle, inert row deletion, and async unmount', async (t) => {
	const { doc } = installFakeDOM(t);
	const main = doc.el('main', { id: 'kitchen-content', tabIndex: -1 });
	const list = doc.el('div');
	const addInput = doc.el('input', { classList: ['add-shopping'] });
	main.append(list, addInput);
	doc.body.append(main);

	// 1. Shopping Edit -> input.shopping-name
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

	// 2. Outgoing animation setting row1.inert = true focuses neighbor row2 remove button
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
});

test('compiled ButlerChat.svelte restores launcher focus across close/toggle and skips inert wrappers', async (t) => {
	const { doc } = installFakeDOM(t);
	const rawButler = readFileSync('src/lib/components/ButlerChat.svelte', 'utf8');
	const scriptStart = rawButler.indexOf('<script lang="ts">');
	const scriptEnd = rawButler.indexOf('</script>', scriptStart);
	const hookedButlerScript =
		rawButler.slice(scriptStart, scriptEnd) +
		`
	(globalThis as any).__onButlerInit?.({
		get open() { return open; },
		set open(value: boolean) { open = value; },
		set launcher(el: HTMLButtonElement | undefined) { launcher = el; },
		set input(el: HTMLTextAreaElement | undefined) { input = el; },
		close,
		toggle
	});
</script>`;
	const butlerJs = ts.transpileModule(
		compile(hookedButlerScript, {
			filename: 'src/lib/components/ButlerChat.svelte',
			generate: 'client'
		}).js.code,
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
	).outputText;

	const noop = () => {};
	const iconProxy = new Proxy({}, { get: () => noop });
	const modMap: Record<string, unknown> = {
		svelte: {
			...svelte,
			onDestroy: () => {},
			tick: () => new Promise<void>((resolve) => queueMicrotask(resolve))
		},
		'svelte/internal/client': svelteClient,
		'svelte/internal/disclose-version': {},
		'@lucide/svelte': iconProxy,
		'./BasilAvatar.svelte': { default: noop },
		'./ChatMarkdown.svelte': { default: noop },
		'#lib/ai-continuation.ts': aiContinuationMod,
		'#lib/butler-actions.ts': butlerActionsMod,
		'#lib/butler-chat.ts': butlerChatMod,
		'#lib/focus.ts': focusMod
	};

	let butlerApi!: {
		open: boolean;
		launcher: HTMLButtonElement | undefined;
		input: HTMLTextAreaElement | undefined;
		close: () => Promise<void>;
		toggle: () => Promise<void>;
	};
	const exports: { default?: any } = {};
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			throw new Error(`Unexpected ButlerChat dependency ${id}`);
		},
		window: globalThis.window,
		document: globalThis.document,
		AbortController,
		Object,
		Array,
		Error,
		Map,
		Set,
		Math,
		JSON,
		String,
		Boolean,
		Promise,
		setTimeout,
		clearTimeout
	};
	sandbox.globalThis = sandbox;
	sandbox.__onButlerInit = (api: typeof butlerApi) => {
		butlerApi = api;
	};
	runInNewContext(butlerJs, sandbox);

	const kitchen = dataMod.createNewUserState();
	const dispose = svelteClient.effect_root(() => {
		exports.default(null, {
			get kitchen() {
				return kitchen;
			},
			owner: 'u1:h1',
			request: async () => ({ reply: 'Hello', commands: [] }),
			apply: () => JSON.stringify(kitchen)
		});
	});
	t.after(dispose);
	await flushMicrotasks();

	const wrapper = doc.el('div');
	const launcher = doc.el('button', { classList: ['butler-launcher'] });
	const input = doc.el('textarea', { id: 'butler-message' });
	wrapper.append(launcher);
	doc.body.append(wrapper);

	butlerApi.launcher = launcher as unknown as HTMLButtonElement;
	butlerApi.input = input as unknown as HTMLTextAreaElement;

	// 1. toggle() opens panel and focuses #butler-message
	const panel1 = doc.el('div', { id: 'butler-panel', tabIndex: -1 });
	panel1.append(input);
	doc.body.append(panel1);
	await butlerApi.toggle();
	assert.equal(butlerApi.open, true);
	assert.equal(doc.activeElement, input);

	// 2. close() explicitly restores focus to launcher even if opened while focus was elsewhere
	const trap1 = focusTrap(panel1 as unknown as HTMLElement);
	await flushMicrotasks();
	await butlerApi.close();
	panel1.remove();
	trap1.destroy();
	await flushMicrotasks();
	assert.equal(butlerApi.open, false);
	assert.equal(doc.activeElement, launcher);
	assert.equal(launcher.lastFocusOptions?.preventScroll, true);

	// 3. toggle() while open delegates to close() and restores launcher focus
	doc.body.append(panel1);
	panel1.setConnected(true);
	await butlerApi.toggle();
	assert.equal(butlerApi.open, true);
	await butlerApi.toggle();
	assert.equal(butlerApi.open, false);
	assert.equal(doc.activeElement, launcher);

	// 4. Chained modal setting wrapper.inert = true prevents close() from stealing focus
	await butlerApi.toggle();
	const modalInput = doc.el('input', { id: 'auth-email' });
	const authDialog = doc.el('div', { tabIndex: -1 });
	authDialog.append(modalInput);
	doc.body.append(authDialog);
	wrapper.inert = true;
	modalInput.focus();
	await butlerApi.close();
	await flushMicrotasks();
	assert.equal(doc.activeElement, modalInput);
});

test('compiled +page.svelte handleWindowKeydown always clears mobileNav on Escape while routing active overlays', async () => {
	const rawPageSource = readFileSync('src/routes/+page.svelte', 'utf8');
	const instanceStart = rawPageSource.indexOf('<script lang="ts">');
	const instanceEnd = rawPageSource.indexOf('</script>', instanceStart);
	const hookedScript =
		rawPageSource.slice(0, instanceEnd) +
		`
	(globalThis as any).__onPageEscapeInit?.({
		get kitchen() { return kitchen; },
		set kitchen(v: AppState) { kitchen = v; },
		get page() { return page; },
		set page(v: string) { page = v; },
		get modal() { return modal; },
		set modal(v: string) { modal = v; },
		get resumeDialog() { return resumeDialog; },
		set resumeDialog(v: string) { resumeDialog = v; },
		get editingRecipe() { return editingRecipe; },
		set editingRecipe(v: Recipe | null) { editingRecipe = v; },
		get editingRecipeMode() { return editingRecipeMode; },
		set editingRecipeMode(v: 'create' | 'edit') { editingRecipeMode = v; },
		get selected() { return selected; },
		set selected(v: Recipe | null) { selected = v; },
		get selectedMealServings() { return selectedMealServings; },
		set selectedMealServings(v: number | undefined) { selectedMealServings = v; },
		get butlerOpen() { return butlerOpen; },
		set butlerOpen(v: boolean) { butlerOpen = v; },
		set butlerChat(v: any) { butlerChat = v; },
		get mobileNav() { return mobileNav; },
		set mobileNav(v: boolean) { mobileNav = v; },
		get pantryDraft() { return pantryDraft; },
		set pantryDraft(v: any) { pantryDraft = v; },
		get editingShoppingId() { return editingShoppingId; },
		set editingShoppingId(v: string) { editingShoppingId = v; },
		handleWindowKeydown
	});
</script>`;
	const clientScriptJs = ts.transpileModule(
		compile(hookedScript, { filename: 'src/routes/+page.svelte', generate: 'client' }).js.code,
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
	).outputText;

	const noop = () => {};
	const iconProxy = new Proxy({}, { get: () => noop });
	const store = new Map<string, string>();
	const storage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear()
	};
	const modMap: Record<string, unknown> = {
		svelte,
		'svelte/animate': svelteAnimate,
		'svelte/internal/client': svelteClient,
		'svelte/internal/disclose-version': {},
		'svelte/internal/server': svelteServer,
		'@lucide/svelte': iconProxy,
		'#lib/cover-upload.ts': coverUploadMod,
		'#lib/recipe-cover.ts': coverMod,
		'#lib/focus.ts': focusMod,
		'#lib/form-validation.ts': formValidationMod,
		'#lib/motion.ts': {
			backdropMotion: () => ({}),
			dialogMotion: () => ({}),
			revealMotion: () => ({}),
			fadeMotion: () => ({}),
			motionDuration: () => 0,
			prefersReducedMotion: () => true
		},
		'#lib/planner.ts': plannerMod,
		'#lib/data.ts': dataMod,
		'#lib/domain.ts': domainMod,
		'#lib/import-session.ts': importSessionMod,
		'#lib/kitchen-export.ts': kitchenExportMod,
		'#lib/kitchen-workflows.ts': workflowsMod,
		'#lib/discovery.ts': discoveryMod,
		'#lib/recipe-collection.ts': recipeCollectionMod,
		'#lib/recipe-detail.ts': recipeDetailMod,
		'#lib/recipe-draft.ts': recipeDraftMod,
		'#lib/butler.ts': butlerMod,
		'#lib/butler-chat.ts': butlerChatMod,
		'#lib/voice-capture.ts': { ...voiceCaptureMod, VoiceCapture: class {} },
		'#lib/voice-config.ts': voiceConfigMod,
		'#lib/ai-connections.ts': aiConnectionsMod,
		'#lib/ai-continuation.ts': aiContinuationMod,
		'#lib/client-workflows.ts': clientWorkflowsMod,
		'#lib/guest-storage.ts': guestMod,
		'#lib/client-sync.ts': syncMod,
		'#lib/recipe-scraper.ts': scraperMod,
		'#lib/components/FormField.svelte': { default: noop },
		'#lib/components/RecipeDetail.svelte': { default: noop },
		'#lib/components/ButlerChat.svelte': { default: noop },
		'#lib/components/RecipeEditor.svelte': { default: noop },
		'#lib/components/SyncStatus.svelte': { default: noop },
		'#lib/components/ToggleButton.svelte': { default: noop },
		'#lib/components/DisclosureButton.svelte': { default: noop },
		'#lib/components/AIConnection.svelte': { default: noop },
		'#lib/components/VoiceSettings.svelte': { default: noop },
		'#lib/components/RecipeImport.svelte': {
			default: noop,
			emptyImportSession: importSessionMod.emptyImportSession
		}
	};

	let api!: {
		kitchen: AppState;
		page: string;
		modal: string;
		resumeDialog: string;
		editingRecipe: Recipe | null;
		editingRecipeMode: 'create' | 'edit';
		selected: Recipe | null;
		selectedMealServings: number | undefined;
		butlerOpen: boolean;
		butlerChat: { close: () => Promise<void> } | undefined;
		mobileNav: boolean;
		pantryDraft: unknown;
		editingShoppingId: string;
		handleWindowKeydown: (e: KeyboardEvent) => void;
	};
	const exports: { default?: any } = {};
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			throw new Error(`Unexpected +page dependency ${id}`);
		},
		Date,
		Intl,
		Map,
		Set,
		Number,
		String,
		Boolean,
		Array,
		Object,
		Math,
		JSON,
		RegExp,
		Error,
		RangeError,
		Promise,
		URL,
		Response,
		Request,
		crypto,
		CSS: { escape: (v: string) => String(v) },
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		localStorage: storage,
		navigator: { onLine: true },
		document: { querySelector: () => null },
		window: {
			location: { assign: () => {}, reload: () => {} },
			scrollTo: () => {}
		},
		fetch: async () =>
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	};
	sandbox.globalThis = sandbox;
	sandbox.__onPageEscapeInit = (instance: typeof api) => {
		api = instance;
	};
	runInNewContext(clientScriptJs, sandbox);
	const dispose = svelteClient.effect_root(() => {
		exports.default(null, { data: { authMode: 'local', loginUrl: null, logoutUrl: null } });
	});

	const pressEscape = (defaultPrevented = false) => {
		let prevented = defaultPrevented;
		const event = {
			key: 'Escape',
			get defaultPrevented() {
				return prevented;
			},
			preventDefault() {
				prevented = true;
			}
		} as unknown as KeyboardEvent;
		api.handleWindowKeydown(event);
		return prevented;
	};

	try {
		const sampleRecipe = dataMod.seedRecipes[0];

		// 1. defaultPrevented Escape (e.g. open SearchPicker listbox) leaves modal and mobileNav untouched.
		api.mobileNav = true;
		api.modal = 'settings';
		pressEscape(true);
		assert.equal(api.mobileNav, true);
		assert.equal(api.modal, 'settings');

		// 2. Window Escape with modal + mobileNav clears mobileNav AND resolves closeDialog() (including resumeDialog).
		api.resumeDialog = 'import';
		api.modal = 'settings';
		api.mobileNav = true;
		pressEscape();
		await flushMicrotasks();
		assert.equal(api.mobileNav, false);
		assert.equal(api.modal, 'import');

		api.mobileNav = true;
		pressEscape();
		await flushMicrotasks();
		assert.equal(api.mobileNav, false);
		assert.equal(api.modal, '');

		// 3. Window Escape with modal layered over editingRecipe + mobileNav clears modal and mobileNav first without clearing underlying editingRecipe; next Escape clears editingRecipe.
		api.mobileNav = true;
		api.modal = 'settings';
		api.editingRecipe = structuredClone(sampleRecipe);
		api.editingRecipeMode = 'create';
		pressEscape();
		await flushMicrotasks();
		assert.equal(api.mobileNav, false);
		assert.equal(api.modal, '');
		assert.equal(api.editingRecipe?.id, sampleRecipe.id);
		assert.equal(api.editingRecipeMode, 'create');

		api.mobileNav = true;
		pressEscape();
		await flushMicrotasks();
		assert.equal(api.mobileNav, false);
		assert.equal(api.editingRecipe, null);
		assert.equal(api.editingRecipeMode, 'edit');

		// 4. Window Escape with selected + mobileNav clears both and resets selectedMealServings.
		api.mobileNav = true;
		api.selected = structuredClone(sampleRecipe);
		api.selectedMealServings = 6;
		pressEscape();
		await flushMicrotasks();
		assert.equal(api.mobileNav, false);
		assert.equal(api.selected, null);
		assert.equal(api.selectedMealServings, undefined);

		// 5. Window Escape with butlerOpen + mobileNav clears mobileNav AND closes ButlerChat.
		let butlerClosed = 0;
		api.butlerChat = {
			close: async () => {
				butlerClosed += 1;
				api.butlerOpen = false;
			}
		};
		api.mobileNav = true;
		api.butlerOpen = true;
		pressEscape();
		await flushMicrotasks();
		assert.equal(api.mobileNav, false);
		assert.equal(butlerClosed, 1);
		assert.equal(api.butlerOpen, false);

		// 6. Window Escape with mobileNav + pantryDraft clears mobileNav first; next Escape cancels pantryDraft.
		const pantryItem = api.kitchen.pantry[0];
		api.mobileNav = true;
		api.pantryDraft = {
			id: pantryItem.id,
			quantity: pantryItem.quantity,
			unit: pantryItem.unit,
			category: pantryItem.category,
			expires: pantryItem.expires ?? ''
		};
		pressEscape();
		await flushMicrotasks();
		assert.equal(api.mobileNav, false);
		assert.notEqual(api.pantryDraft, null);

		pressEscape();
		await flushMicrotasks();
		assert.equal(api.pantryDraft, null);

		// 7. Window Escape on shopping page cancels active inline shopping edit and calls preventDefault().
		api.page = 'shopping';
		api.editingShoppingId = 'shop-1';
		const prevented = pressEscape();
		await flushMicrotasks();
		assert.equal(prevented, true);
		assert.equal(api.editingShoppingId, '');
	} finally {
		dispose();
	}
});
