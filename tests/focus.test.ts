import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import * as focusMod from '../src/lib/focus.ts';

const { focusableControls, focusTrap } = focusMod;
const nodeRequire = createRequire(import.meta.url);
const svelteInternalClient = nodeRequire('svelte/internal/client');
const { createRawSnippet, flushSync, mount, unmount } = nodeRequire(
	'../node_modules/svelte/src/index-client.js'
) as typeof import('svelte');

type ListenerEntry = {
	listener: (event: any) => void;
	capture: boolean;
};

type ObserverTarget = {
	target: MockNode;
	attributeFilter?: string[];
};

const activeObservers = new Set<MockMutationObserver>();

class MockMutationObserver {
	private callback: (
		records: Array<{ type: 'attributes'; target: MockNode; attributeName: string }>
	) => void;
	private targets: ObserverTarget[] = [];
	private pending: Array<{ type: 'attributes'; target: MockNode; attributeName: string }> = [];
	private scheduled = false;

	constructor(
		callback: (
			records: Array<{ type: 'attributes'; target: MockNode; attributeName: string }>
		) => void
	) {
		this.callback = callback;
	}

	observe(target: MockNode, options?: { attributes?: boolean; attributeFilter?: string[] }) {
		this.targets.push({ target, attributeFilter: options?.attributeFilter });
		activeObservers.add(this);
	}

	disconnect() {
		this.targets = [];
		this.pending = [];
		activeObservers.delete(this);
	}

	notifyAttribute(target: MockNode, attributeName: string) {
		const matched = this.targets.some(
			(entry) =>
				entry.target === target &&
				(!entry.attributeFilter || entry.attributeFilter.includes(attributeName))
		);
		if (!matched) return;
		this.pending.push({ type: 'attributes', target, attributeName });
		if (!this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => {
				this.scheduled = false;
				if (!this.pending.length || !activeObservers.has(this)) return;
				const batch = this.pending.splice(0, this.pending.length);
				this.callback(batch);
			});
		}
	}
}

function notifyAttributeMutation(target: MockNode, attributeName: string) {
	for (const observer of [...activeObservers]) {
		observer.notifyAttribute(target, attributeName);
	}
}

class MockEventTarget {
	listeners = new Map<string, ListenerEntry[]>();

	addEventListener(
		type: string,
		listener: (event: any) => void,
		options?: boolean | { capture?: boolean }
	) {
		const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
		let list = this.listeners.get(type);
		if (!list) {
			list = [];
			this.listeners.set(type, list);
		}
		if (!list.some((item) => item.listener === listener && item.capture === capture)) {
			list.push({ listener, capture });
		}
	}

	removeEventListener(
		type: string,
		listener: (event: any) => void,
		options?: boolean | { capture?: boolean }
	) {
		const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
		const list = this.listeners.get(type);
		if (!list) return;
		const idx = list.findIndex((item) => item.listener === listener && item.capture === capture);
		if (idx !== -1) list.splice(idx, 1);
	}

	invokeListeners(type: string, event: any, capturePhase: boolean) {
		const list = [...(this.listeners.get(type) ?? [])];
		for (const entry of list) {
			if (entry.capture === capturePhase) {
				entry.listener.call(this, event);
			}
		}
	}

	dispatchEvent(rawEvent: {
		type: string;
		bubbles?: boolean;
		target?: unknown;
		[key: string]: any;
	}) {
		const bubbles = Boolean(rawEvent.bubbles);
		if (!bubbles) {
			let prevented = Boolean(rawEvent.defaultPrevented);
			if (!rawEvent.target) {
				Object.defineProperty(rawEvent, 'target', {
					configurable: true,
					value: this
				});
			}
			Object.defineProperty(rawEvent, 'currentTarget', {
				configurable: true,
				value: this
			});
			if (typeof rawEvent.preventDefault !== 'function') {
				rawEvent.preventDefault = () => {
					prevented = true;
				};
				Object.defineProperty(rawEvent, 'defaultPrevented', {
					configurable: true,
					get: () => prevented
				});
			}
			if (typeof rawEvent.stopPropagation !== 'function') {
				rawEvent.stopPropagation = () => {};
			}
			this.invokeListeners(rawEvent.type, rawEvent, false);
			return !rawEvent.defaultPrevented;
		}
		return dispatchBubbling(this, rawEvent);
	}
}

class MockNode extends MockEventTarget {
	nodeType = 1;
	childNodes: MockNode[] = [];
	parentNode: MockNode | null = null;
	ownerDocument: MockDocument;
	data = '';

	constructor(doc: MockDocument, nodeType = 1) {
		super();
		this.ownerDocument = doc;
		this.nodeType = nodeType;
	}

	get parentElement(): MockElement | null {
		return this.parentNode instanceof MockElement ? this.parentNode : null;
	}

	get firstChild(): MockNode | null {
		return this.childNodes[0] ?? null;
	}

	get lastChild(): MockNode | null {
		return this.childNodes[this.childNodes.length - 1] ?? null;
	}

	get nextSibling(): MockNode | null {
		if (!this.parentNode) return null;
		const idx = this.parentNode.childNodes.indexOf(this);
		return idx !== -1 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
	}

	get previousSibling(): MockNode | null {
		if (!this.parentNode) return null;
		const idx = this.parentNode.childNodes.indexOf(this);
		return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null;
	}

	get isConnected(): boolean {
		let cur: MockNode | null = this;
		while (cur) {
			if (cur === this.ownerDocument || cur === this.ownerDocument.documentElement) return true;
			cur = cur.parentNode;
		}
		return false;
	}

	get textContent(): string {
		if (this.nodeType === 3 || this.nodeType === 8) return this.data;
		return this.childNodes.map((child) => child.textContent).join('');
	}

	set textContent(value: string) {
		if (this.nodeType === 3 || this.nodeType === 8) {
			this.data = value;
			return;
		}
		for (const child of this.childNodes) child.parentNode = null;
		this.childNodes = value ? [new MockText(this.ownerDocument, value)] : [];
		for (const child of this.childNodes) child.parentNode = this;
	}

	appendChild<T extends MockNode>(node: T): T {
		return this.insertBefore(node, null);
	}

	append(...nodes: MockNode[]) {
		for (const node of nodes) this.appendChild(node);
		return this;
	}

	insertBefore<T extends MockNode>(node: T, ref: MockNode | null): T {
		const nodesToInsert =
			node instanceof MockDocumentFragment ? [...node.childNodes] : [node as MockNode];
		if (node instanceof MockDocumentFragment) node.childNodes = [];
		for (const item of nodesToInsert) {
			if (item.parentNode) item.parentNode.removeChild(item);
			item.parentNode = this;
			if (ref === null) {
				this.childNodes.push(item);
			} else {
				const idx = this.childNodes.indexOf(ref);
				if (idx === -1) this.childNodes.push(item);
				else this.childNodes.splice(idx, 0, item);
			}
		}
		return node;
	}

	removeChild<T extends MockNode>(node: T): T {
		const idx = this.childNodes.indexOf(node);
		if (idx !== -1) {
			this.childNodes.splice(idx, 1);
			node.parentNode = null;
		}
		return node;
	}

	remove() {
		if (this.parentNode) this.parentNode.removeChild(this);
	}

	before(...nodes: MockNode[]) {
		if (!this.parentNode) return;
		for (const node of nodes) this.parentNode.insertBefore(node, this);
	}

	after(...nodes: MockNode[]) {
		if (!this.parentNode) return;
		const ref = this.nextSibling;
		for (const node of nodes) this.parentNode.insertBefore(node, ref);
	}

	contains(other: MockNode | null): boolean {
		let cur = other;
		while (cur) {
			if (cur === this) return true;
			cur = cur.parentNode;
		}
		return false;
	}

	cloneNode(deep = false): MockNode {
		const copy = new MockNode(this.ownerDocument, this.nodeType);
		copy.data = this.data;
		if (deep) {
			for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
		}
		return copy;
	}
}

class MockText extends MockNode {
	constructor(doc: MockDocument, text = '') {
		super(doc, 3);
		this.data = text;
	}

	override cloneNode(): MockText {
		return new MockText(this.ownerDocument, this.data);
	}
}

class MockComment extends MockNode {
	constructor(doc: MockDocument, text = '') {
		super(doc, 8);
		this.data = text;
	}

	override cloneNode(): MockComment {
		return new MockComment(this.ownerDocument, this.data);
	}
}

class MockDocumentFragment extends MockNode {
	constructor(doc: MockDocument) {
		super(doc, 11);
	}

	override cloneNode(deep = false): MockDocumentFragment {
		const copy = new MockDocumentFragment(this.ownerDocument);
		if (deep) {
			for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
		}
		return copy;
	}
}

class MockElement extends MockNode {
	tagName: string;
	nodeName: string;
	namespaceURI = 'http://www.w3.org/1999/xhtml';
	attributes = new Map<string, string>();
	style: Record<string, string> = {
		overflow: '',
		display: 'block',
		visibility: 'visible',
		position: 'static'
	};
	private _hidden = false;
	private _inert = false;
	open = false;
	disabled = false;
	scrollTop = 0;
	offsetParent: object | null = {};
	lastFocusOptions: { preventScroll?: boolean } | undefined = undefined;
	content: MockDocumentFragment | null = null;
	private _innerHTML = '';

	constructor(doc: MockDocument, tagName: string, attrs: Record<string, string> = {}) {
		super(doc, 1);
		this.tagName = tagName.toUpperCase();
		this.nodeName = this.tagName;
		if (this.tagName === 'TEMPLATE') {
			this.content = new MockDocumentFragment(doc);
		}
		for (const [key, value] of Object.entries(attrs)) {
			this.setAttribute(key, value);
		}
	}

	get children(): MockElement[] {
		return this.childNodes.filter((child): child is MockElement => child instanceof MockElement);
	}

	get className(): string {
		return this.attributes.get('class') ?? '';
	}

	set className(value: string) {
		if (value) this.attributes.set('class', value);
		else this.attributes.delete('class');
	}

	get classList() {
		const tokens = () =>
			(this.attributes.get('class') ?? '')
				.split(/\s+/)
				.map((part) => part.trim())
				.filter(Boolean);
		return {
			contains: (cls: string) => tokens().includes(cls),
			add: (...names: string[]) => {
				const set = new Set([...tokens(), ...names]);
				this.className = [...set].join(' ');
			},
			remove: (...names: string[]) => {
				const removeSet = new Set(names);
				this.className = tokens()
					.filter((item) => !removeSet.has(item))
					.join(' ');
			},
			toggle: (name: string, force?: boolean) => {
				const cur = tokens();
				const has = cur.includes(name);
				const shouldHave = force ?? !has;
				if (shouldHave && !has) this.className = [...cur, name].join(' ');
				else if (!shouldHave && has) this.className = cur.filter((item) => item !== name).join(' ');
				return shouldHave;
			}
		};
	}

	get hidden(): boolean {
		return this._hidden;
	}

	set hidden(value: boolean) {
		const next = Boolean(value);
		this._hidden = next;
		if (next) this.attributes.set('hidden', '');
		else this.attributes.delete('hidden');
	}

	get inert(): boolean {
		return this._inert;
	}

	set inert(value: boolean) {
		const next = Boolean(value);
		if (this._inert === next && this.attributes.has('inert') === next) return;
		this._inert = next;
		if (next) this.attributes.set('inert', '');
		else this.attributes.delete('inert');
		notifyAttributeMutation(this, 'inert');
	}

	get innerHTML(): string {
		return this._innerHTML;
	}

	set innerHTML(html: string) {
		this._innerHTML = html;
		const target = this.tagName === 'TEMPLATE' && this.content ? this.content : this;
		target.childNodes = [];
		parseHtmlInto(this.ownerDocument, html, target);
	}

	append(...nodes: MockNode[]) {
		for (const node of nodes) this.appendChild(node);
		return this;
	}

	focus(options?: { preventScroll?: boolean }) {
		if (!this.isConnected || this.closest('[inert], [hidden]')) return;
		this.lastFocusOptions = options;
		this.ownerDocument.activeElement = this;
		dispatchBubbling(this, { type: 'focusin', bubbles: true });
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
		const notTabIndexMinusOne = this.attributes.get('tabindex') !== '-1';
		if (selector === '[inert]') return this._inert || this.attributes.has('inert');
		if (selector === '[hidden]') return this._hidden || this.attributes.has('hidden');
		if (selector === '[data-focus-backdrop]') return this.attributes.has('data-focus-backdrop');
		if (selector === '[aria-modal="true"]') return this.attributes.get('aria-modal') === 'true';
		if (selector === '[role="dialog"]') return this.attributes.get('role') === 'dialog';
		if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
		if (selector.startsWith('#')) return this.attributes.get('id') === selector.slice(1);
		if (selector === 'button:not([disabled])') return this.tagName === 'BUTTON' && !this.disabled;
		if (selector === 'button:not([disabled]):not([tabindex="-1"])')
			return this.tagName === 'BUTTON' && !this.disabled && notTabIndexMinusOne;
		if (selector === 'a[href]') return this.tagName === 'A' && this.attributes.has('href');
		if (selector === 'a[href]:not([tabindex="-1"])')
			return this.tagName === 'A' && this.attributes.has('href') && notTabIndexMinusOne;
		if (selector === 'input:not([disabled])') return this.tagName === 'INPUT' && !this.disabled;
		if (selector === 'input:not([disabled]):not([tabindex="-1"])')
			return this.tagName === 'INPUT' && !this.disabled && notTabIndexMinusOne;
		if (selector === 'select:not([disabled])') return this.tagName === 'SELECT' && !this.disabled;
		if (selector === 'select:not([disabled]):not([tabindex="-1"])')
			return this.tagName === 'SELECT' && !this.disabled && notTabIndexMinusOne;
		if (selector === 'textarea:not([disabled])')
			return this.tagName === 'TEXTAREA' && !this.disabled;
		if (selector === 'textarea:not([disabled]):not([tabindex="-1"])')
			return this.tagName === 'TEXTAREA' && !this.disabled && notTabIndexMinusOne;
		if (selector === '[tabindex="0"]') return this.attributes.get('tabindex') === '0';
		if (selector === '[tabindex]:not([tabindex="-1"])')
			return this.attributes.has('tabindex') && notTabIndexMinusOne;
		if (
			selector === 'details > summary:first-of-type' ||
			selector === 'details > summary:first-of-type:not([tabindex="-1"])'
		) {
			if (this.tagName !== 'SUMMARY' || this.parentElement?.tagName !== 'DETAILS') return false;
			if (selector.endsWith(':not([tabindex="-1"])') && !notTabIndexMinusOne) return false;
			const firstSummary = this.parentElement.children.find((child) => child.tagName === 'SUMMARY');
			return firstSummary === this;
		}
		const ariaLabelMatch = selector.match(/^\[aria-label="([^"]+)"\]$/);
		if (ariaLabelMatch) return this.attributes.get('aria-label') === ariaLabelMatch[1];
		return this.tagName === selector.toUpperCase();
	}

	querySelector(selector: string): MockElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
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
		const prevHad = this.attributes.has(name);
		const prevVal = this.attributes.get(name);
		this.attributes.set(name, String(value));
		if (name === 'open') this.open = true;
		if (name === 'disabled') this.disabled = true;
		if (name === 'hidden') this._hidden = true;
		if (name === 'inert') {
			this._inert = true;
			if (!prevHad || prevVal !== String(value)) notifyAttributeMutation(this, 'inert');
		}
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	removeAttribute(name: string) {
		const had = this.attributes.delete(name);
		if (name === 'open') this.open = false;
		if (name === 'disabled') this.disabled = false;
		if (name === 'hidden') this._hidden = false;
		if (name === 'inert') {
			const changed = had || this._inert;
			this._inert = false;
			if (changed) notifyAttributeMutation(this, 'inert');
		}
	}

	override cloneNode(deep = false): MockElement {
		const copy = new MockElement(this.ownerDocument, this.tagName);
		for (const [k, v] of this.attributes.entries()) copy.setAttribute(k, v);
		if (deep) {
			for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
		}
		return copy;
	}
}

class MockHTMLMediaElement extends MockElement {}

function parseHtmlInto(doc: MockDocument, html: string, parent: MockNode) {
	const stack: MockNode[] = [parent];
	const tokenRe = /<!--([\s\S]*?)-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
	const voidTags = new Set(['INPUT', 'IMG', 'BR', 'HR', 'META', 'LINK']);
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(html)) !== null) {
		const current = stack[stack.length - 1];
		if (match[1] !== undefined) {
			current.appendChild(new MockComment(doc, match[1]));
		} else if (match[2] !== undefined) {
			if (stack.length > 1) stack.pop();
		} else if (match[3] !== undefined) {
			const tag = match[3];
			const rawAttrs = match[4] ?? '';
			const selfClosing = rawAttrs.trim().endsWith('/');
			const el = new MockElement(doc, tag);
			const attrRe = /([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g;
			let attrMatch: RegExpExecArray | null;
			while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
				el.setAttribute(attrMatch[1], attrMatch[2] ?? '');
			}
			current.appendChild(el);
			if (!selfClosing && !voidTags.has(el.tagName)) stack.push(el);
		} else if (match[5] !== undefined) {
			current.appendChild(new MockText(doc, match[5]));
		}
	}
}

function dispatchBubbling(startTarget: MockEventTarget, rawEvent: Record<string, any>): boolean {
	const doc =
		startTarget instanceof MockNode
			? startTarget.ownerDocument
			: startTarget instanceof MockDocument
				? startTarget
				: mockDoc;
	const path: MockEventTarget[] = [];
	if (startTarget instanceof MockNode) {
		let cur: MockNode | null = startTarget;
		while (cur) {
			path.push(cur);
			cur = cur.parentNode;
		}
		if (path[path.length - 1] !== doc) path.push(doc);
		path.push(doc.defaultView);
	} else if (startTarget instanceof MockDocument) {
		path.push(doc, doc.defaultView);
	} else {
		path.push(startTarget);
	}

	let prevented = Boolean(rawEvent.defaultPrevented);
	let stopped = Boolean(rawEvent.cancelBubble);
	const event: Record<string, any> = {
		...rawEvent,
		bubbles: true,
		target: rawEvent.target ?? startTarget,
		composedPath: () => path,
		get defaultPrevented() {
			return prevented;
		},
		preventDefault() {
			prevented = true;
		},
		get cancelBubble() {
			return stopped;
		},
		stopPropagation() {
			stopped = true;
		}
	};

	for (let i = path.length - 1; i >= 1 && !stopped; i--) {
		Object.defineProperty(event, 'currentTarget', { configurable: true, value: path[i] });
		path[i].invokeListeners(event.type, event, true);
	}
	for (let i = 0; i < path.length && !stopped; i++) {
		Object.defineProperty(event, 'currentTarget', { configurable: true, value: path[i] });
		path[i].invokeListeners(event.type, event, false);
	}
	return !prevented;
}

class MockWindow extends MockEventTarget {
	document!: MockDocument;
	navigator = { userAgent: 'NodeMockDOM' };
	private nextRafId = 1;
	private rafCallbacks = new Map<number, () => void>();

	getComputedStyle(el: MockElement) {
		return el.style;
	}

	requestAnimationFrame = (cb: () => void): number => {
		const id = this.nextRafId++;
		this.rafCallbacks.set(id, cb);
		return id;
	};

	cancelAnimationFrame = (id: number) => {
		this.rafCallbacks.delete(id);
	};

	flushAnimationFrames() {
		const pending = [...this.rafCallbacks.values()];
		this.rafCallbacks.clear();
		for (const cb of pending) cb();
	}

	reset() {
		this.listeners.clear();
		this.rafCallbacks.clear();
	}
}

class MockDocument extends MockNode {
	body: MockElement;
	documentElement: MockElement;
	activeElement: MockElement | null = null;
	defaultView: MockWindow;

	constructor(win: MockWindow) {
		super(null as unknown as MockDocument, 9);
		this.ownerDocument = this;
		this.defaultView = win;
		win.document = this;
		this.documentElement = new MockElement(this, 'html');
		this.body = new MockElement(this, 'body');
		this.documentElement.appendChild(this.body);
		this.appendChild(this.documentElement);
		this.activeElement = this.body;
	}

	createElement(tag: string) {
		return new MockElement(this, tag);
	}

	createTextNode(text = '') {
		return new MockText(this, text);
	}

	createComment(text = '') {
		return new MockComment(this, text);
	}

	createDocumentFragment() {
		return new MockDocumentFragment(this);
	}

	importNode<T extends MockNode>(node: T, deep = false): T {
		return node.cloneNode(deep) as T;
	}

	querySelector(selector: string): MockElement | null {
		return this.documentElement.querySelector(selector);
	}

	querySelectorAll(selector: string): MockElement[] {
		return this.documentElement.querySelectorAll(selector);
	}

	el(tag: string, attrs: Record<string, string> = {}) {
		return new MockElement(this, tag, attrs);
	}

	reset() {
		activeObservers.clear();
		this.listeners.clear();
		this.defaultView.reset();
		this.body.childNodes = [];
		this.body.listeners.clear();
		this.body.style.overflow = '';
		this.body.inert = false;
		this.body.hidden = false;
		this.activeElement = this.body;
	}
}

const mockWin = new MockWindow();
const mockDoc = new MockDocument(mockWin);

function installGlobalDOM() {
	(globalThis as any).Node = MockNode;
	(globalThis as any).Element = MockElement;
	(globalThis as any).HTMLElement = MockElement;
	(globalThis as any).HTMLMediaElement = MockHTMLMediaElement;
	(globalThis as any).Text = MockText;
	(globalThis as any).Comment = MockComment;
	(globalThis as any).DocumentFragment = MockDocumentFragment;
	(globalThis as any).MutationObserver = MockMutationObserver;
	(globalThis as any).window = mockWin;
	(globalThis as any).document = mockDoc;
	(globalThis as any).requestAnimationFrame = mockWin.requestAnimationFrame;
	(globalThis as any).cancelAnimationFrame = mockWin.cancelAnimationFrame;
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: mockWin.navigator
	});
}

installGlobalDOM();

function compileClientComponent(filePath: string) {
	const source = readFileSync(filePath, 'utf8');
	const compiled = compile(source, { filename: filePath, generate: 'client' }).js.code;
	const cjs = ts.transpileModule(compiled, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
	}).outputText;

	const noopIcon = () => {};
	const iconProxy = new Proxy({}, { get: () => noopIcon });
	const modMap: Record<string, unknown> = {
		'svelte/internal/disclose-version': {},
		'svelte/internal/client': svelteInternalClient,
		'@lucide/svelte': iconProxy,
		'#lib/focus.ts': focusMod,
		'#lib/motion.ts': {
			backdropMotion: () => ({ duration: 0 }),
			dialogMotion: () => ({ duration: 0 })
		}
	};

	const exports: { default?: any } = {};
	const sandbox: Record<string, unknown> = {
		exports,
		module: { exports },
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			throw new Error(`Unexpected dependency ${id} in ${filePath}`);
		},
		window: mockWin,
		document: mockDoc,
		MutationObserver: MockMutationObserver,
		requestAnimationFrame: mockWin.requestAnimationFrame,
		cancelAnimationFrame: mockWin.cancelAnimationFrame,
		queueMicrotask,
		setTimeout,
		clearTimeout
	};
	sandbox.globalThis = sandbox;
	runInNewContext(cjs, sandbox);
	return exports.default;
}

const ModalDialog = compileClientComponent('src/lib/components/ModalDialog.svelte');
const MobileDrawer = compileClientComponent('src/lib/components/MobileDrawer.svelte');

async function flushMicrotasks(turns = 4) {
	for (let i = 0; i < turns; i++) {
		await Promise.resolve();
	}
}

function withMockDOM(run: (doc: MockDocument, win: MockWindow) => Promise<void> | void) {
	return async () => {
		installGlobalDOM();
		mockDoc.reset();
		try {
			await run(mockDoc, mockWin);
		} finally {
			mockDoc.reset();
		}
	};
}

function tabEvent(shiftKey = false) {
	let prevented = false;
	return {
		type: 'keydown',
		key: 'Tab',
		shiftKey,
		bubbles: false,
		get defaultPrevented() {
			return prevented;
		},
		preventDefault() {
			prevented = true;
		}
	};
}

test(
	'focusableControls includes visible summary disclosures, skips closed details children, and excludes tabindex="-1"',
	withMockDOM(async (doc) => {
		const dialog = doc.el('div', { 'aria-modal': 'true' });
		const closeBtn = doc.el('button');
		const inactiveTabBtn = doc.el('button', { tabindex: '-1', role: 'tab' });
		const inactiveRadioBtn = doc.el('button', { tabindex: '-1', role: 'radio' });
		const closedDetails = doc.el('details');
		const closedSummary = doc.el('summary');
		const hiddenSelect = doc.el('select');
		const hiddenInput = doc.el('input');
		closedDetails.append(closedSummary, hiddenSelect, hiddenInput);

		const openDetails = doc.el('details', { open: '' });
		const openSummary = doc.el('summary');
		const visibleInput = doc.el('input');
		openDetails.append(openSummary, visibleInput);

		const scrollRegion = doc.el('div', { tabindex: '0', role: 'region' });
		const programmaticTarget = doc.el('div', { tabindex: '-1' });
		const saveBtn = doc.el('button');
		dialog.append(
			closeBtn,
			inactiveTabBtn,
			inactiveRadioBtn,
			closedDetails,
			openDetails,
			scrollRegion,
			programmaticTarget,
			saveBtn
		);
		doc.body.append(dialog);

		assert.deepEqual(focusableControls(dialog as unknown as HTMLElement), [
			closeBtn,
			closedSummary,
			openSummary,
			visibleInput,
			scrollRegion,
			saveBtn
		]);

		const trigger = doc.el('button');
		doc.body.append(trigger);
		trigger.focus();

		const trap = focusTrap(dialog as unknown as HTMLElement);
		await flushMicrotasks();
		assert.equal(doc.activeElement, closeBtn);

		saveBtn.hidden = true;
		scrollRegion.hidden = true;
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
		assert.equal(doc.activeElement, trigger);
		assert.deepEqual(trigger.lastFocusOptions, { preventScroll: true });
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

		const drawerTrap = focusTrap(drawer as unknown as HTMLElement, {
			enabled: false,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		assert.equal(doc.body.style.overflow, '');

		menuBtn.focus();
		drawerTrap.update({
			enabled: true,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		await flushMicrotasks();
		assert.equal(doc.activeElement, drawerClose);
		assert.equal(doc.body.style.overflow, 'hidden');

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

		menuBtn.inert = true;
		drawerTrap.update({
			enabled: false,
			returnFocus: () => menuBtn as unknown as HTMLElement
		});
		const trap1 = focusTrap(modal1 as unknown as HTMLElement, { key: 'settings' });
		await flushMicrotasks();

		assert.equal(doc.activeElement, modal1Close);
		assert.equal(doc.body.style.overflow, 'hidden');

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

		trap1.destroy();
		await flushMicrotasks();
		assert.equal(doc.activeElement, modal2Close);
		assert.equal(doc.body.style.overflow, 'hidden');

		menuBtn.inert = false;
		modal2.dispatchEvent({ type: 'outrostart', target: modal2 });
		await flushMicrotasks();
		assert.equal(doc.activeElement, menuBtn);
		assert.equal(doc.body.style.overflow, '');

		trap2.destroy();
		drawerTrap.destroy();
	})
);

test(
	'ModalDialog handles Escape with stopPropagation, honors child defaultPrevented, switches viewKey cleanly, and strips aria-modal on outrostart/inert',
	withMockDOM(async (doc, win) => {
		const trigger = doc.el('button', { class: 'settings-trigger' });
		const mountRoot = doc.el('div');
		doc.body.append(trigger, mountRoot);
		trigger.focus();

		let closeCalls = 0;
		let windowEscapeCalls = 0;
		let currentViewKey = 'settings';
		let comboboxExpanded = true;

		win.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				windowEscapeCalls += 1;
			}
		});

		const props = svelteInternalClient.proxy({
			onclose: () => {
				closeCalls += 1;
			},
			label: 'Settings',
			closeLabel: 'Close settings',
			viewKey: currentViewKey,
			children: createRawSnippet(() => ({
				render: () =>
					`<div class="dialog-inner"><input class="combobox-input" /><button type="button" class="save-btn">Save</button></div>`,
				setup(node: Element) {
					const input = (node as unknown as MockElement).querySelector('.combobox-input');
					input?.addEventListener('keydown', (event) => {
						if (event.key === 'Escape' && comboboxExpanded) {
							comboboxExpanded = false;
							event.preventDefault();
							event.stopPropagation();
						}
					});
				}
			}))
		});

		const instance = mount(ModalDialog, {
			target: mountRoot as unknown as Element,
			props
		});
		flushSync();
		await flushMicrotasks();

		const dialog = mountRoot.querySelector('[role="dialog"]')!;
		assert.ok(dialog);
		assert.equal(dialog.getAttribute('aria-modal'), 'true');
		assert.equal(dialog.getAttribute('aria-label'), 'Settings');
		assert.equal(doc.querySelectorAll('[aria-modal="true"]').length, 1);

		const closeBtn = dialog.querySelector('.dialog-close')!;
		assert.equal(doc.activeElement, closeBtn);

		// 1st Escape inside expanded child combobox prevents default -> ModalDialog stays open
		const combobox = dialog.querySelector('.combobox-input')!;
		combobox.focus();
		combobox.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
		assert.equal(comboboxExpanded, false);
		assert.equal(closeCalls, 0);
		assert.equal(windowEscapeCalls, 0);

		// 2nd Escape on collapsed combobox closes ModalDialog AND stops propagation before window
		const secondEsc = { type: 'keydown', key: 'Escape', bubbles: true };
		const notPrevented = combobox.dispatchEvent(secondEsc);
		assert.equal(notPrevented, false);
		assert.equal(closeCalls, 1);
		assert.equal(windowEscapeCalls, 0);

		// Clicking header close button invokes onclose
		closeBtn.dispatchEvent({ type: 'click', bubbles: true });
		assert.equal(closeCalls, 2);

		// Switching viewKey resets scrollTop, keeps strictly 1 [aria-modal="true"], and re-focuses
		dialog.scrollTop = 180;
		props.viewKey = 'delete';
		props.label = 'Delete account';
		flushSync();
		await flushMicrotasks();
		assert.equal(dialog.scrollTop, 0);
		assert.equal(dialog.getAttribute('aria-label'), 'Delete account');
		assert.equal(doc.querySelectorAll('[aria-modal="true"]').length, 1);
		assert.equal(doc.activeElement, closeBtn);

		// Setting dialog inert (Svelte 5 pause_effect) or outrostart strips aria-modal immediately
		dialog.inert = true;
		await flushMicrotasks();
		assert.equal(dialog.getAttribute('aria-modal'), null);
		assert.equal(doc.body.style.overflow, '');
		assert.equal(doc.activeElement, trigger);
		assert.deepEqual(trigger.lastFocusOptions, { preventScroll: true });

		await unmount(instance);
	})
);

test(
	'MobileDrawer restores focus to .mobile-menu when <main inert> is still set at restore time across Escape, X, backdrop, and Dismiss',
	withMockDOM(async (doc, win) => {
		const shell = doc.el('div', { class: 'app-shell' });
		const drawerRoot = doc.el('div');
		const main = doc.el('main', { id: 'kitchen-content', tabindex: '-1' });
		const menuBtn = doc.el('button', {
			class: 'icon-button mobile-menu',
			'aria-label': 'Toggle navigation'
		});
		main.append(menuBtn);
		shell.append(drawerRoot, main);
		doc.body.append(shell);

		let closeReason = '';
		const drawerProps = svelteInternalClient.proxy({
			open: false,
			modal: false,
			hidden: false,
			trigger: menuBtn as unknown as HTMLElement,
			onclose: () => {
				// Simulate <main inert> still remaining set when MobileDrawer closes and initial restore microtask runs:
				// drawer closes now, while main.inert stays true through the initial microtask before clearing!
				drawerProps.open = false;
				drawerProps.modal = false;
				drawerProps.hidden = true;
				flushSync();
				if (closeReason === 'backdrop' || closeReason === 'dismiss') {
					// Clear main.inert via delayed attribute mutation (after initial microtasks) to exercise MutationObserver path
					setTimeout(() => {
						main.inert = false;
					}, 0);
				} else {
					// Clear main.inert after the initial restore microtask has already fired
					queueMicrotask(() => {
						queueMicrotask(() => {
							main.inert = false;
						});
					});
				}
			},
			children: createRawSnippet(() => ({
				render: () => `<nav><button type="button" class="nav-item">Discover</button></nav>`
			}))
		});

		// Window-level Escape fallback listener matching +page.svelte
		win.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && !event.defaultPrevented && drawerProps.open) {
				event.preventDefault();
				drawerProps.onclose();
			}
		});

		const instance = mount(MobileDrawer, {
			target: drawerRoot as unknown as Element,
			props: drawerProps
		});
		flushSync();

		const sidebar = drawerRoot.querySelector('#kitchen-sidebar')!;
		assert.ok(sidebar);
		// Desktop (>650px): non-modal, not inert
		assert.equal(sidebar.getAttribute('role'), null);
		assert.equal(sidebar.getAttribute('aria-modal'), null);
		assert.equal(sidebar.inert, false);

		// Narrow closed state: inert and non-modal
		drawerProps.hidden = true;
		flushSync();
		assert.equal(sidebar.inert, true);
		assert.equal(sidebar.getAttribute('aria-modal'), null);

		const openMobileDrawer = async () => {
			menuBtn.focus();
			assert.equal(doc.activeElement, menuBtn);
			drawerProps.open = true;
			drawerProps.modal = true;
			drawerProps.hidden = false;
			main.inert = true;
			flushSync();
			await flushMicrotasks();

			assert.equal(sidebar.getAttribute('role'), 'dialog');
			assert.equal(sidebar.getAttribute('aria-modal'), 'true');
			assert.equal(sidebar.inert, false);
			assert.equal(main.inert, true);
			assert.equal(doc.body.style.overflow, 'hidden');
			assert.equal(sidebar.contains(doc.activeElement), true);
		};

		// 1. Close via Escape inside #kitchen-sidebar while <main inert> is still true at initial restore microtask
		closeReason = 'escape';
		await openMobileDrawer();
		const navItem = sidebar.querySelector('.nav-item')!;
		navItem.focus();
		navItem.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
		// Immediately after first microtask, main.inert is STILL true
		await Promise.resolve();
		assert.equal(main.inert, true);
		assert.equal(sidebar.getAttribute('aria-modal'), null);
		// Once <main inert> clears on subsequent microtasks, focus lands on .mobile-menu
		await flushMicrotasks(8);
		assert.equal(main.inert, false);
		assert.equal(doc.activeElement, menuBtn);
		assert.deepEqual(menuBtn.lastFocusOptions, { preventScroll: true });
		assert.equal(doc.body.style.overflow, '');

		// 1b. Close via window-level Escape when focus fell to document.body
		closeReason = 'window-escape';
		await openMobileDrawer();
		doc.activeElement = doc.body;
		win.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: false });
		await flushMicrotasks(8);
		assert.equal(main.inert, false);
		assert.equal(doc.activeElement, menuBtn);

		// 2. Close via X (.sidebar-close) button while <main inert> is still true at initial restore microtask
		closeReason = 'x';
		await openMobileDrawer();
		const closeBtn = sidebar.querySelector('.sidebar-close')!;
		closeBtn.focus();
		closeBtn.dispatchEvent({ type: 'click', bubbles: true });
		await Promise.resolve();
		assert.equal(main.inert, true);
		await flushMicrotasks(8);
		assert.equal(main.inert, false);
		assert.equal(doc.activeElement, menuBtn);

		// 3. Close via pointer click on .nav-backdrop while <main inert> clears asynchronously via MutationObserver
		closeReason = 'backdrop';
		await openMobileDrawer();
		const backdrop = drawerRoot.querySelector('.nav-backdrop')!;
		assert.ok(backdrop);
		const pointerDownAllowed = backdrop.dispatchEvent({ type: 'pointerdown', bubbles: true });
		assert.equal(pointerDownAllowed, false);
		backdrop.dispatchEvent({ type: 'click', bubbles: true });
		await flushMicrotasks(8);
		// main.inert is STILL true across all microtasks until macrotask clears it
		assert.equal(main.inert, true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await flushMicrotasks(4);
		assert.equal(main.inert, false);
		assert.equal(doc.activeElement, menuBtn);

		// 4. Close via assistive-technology activation of [aria-label="Dismiss navigation"] ("Dismiss")
		// even when the Dismiss button itself holds document.activeElement and <main inert> clears asynchronously
		closeReason = 'dismiss';
		await openMobileDrawer();
		const dismissBtn = drawerRoot.querySelector('[aria-label="Dismiss navigation"]')!;
		assert.ok(dismissBtn);
		dismissBtn.focus();
		assert.equal(doc.activeElement, dismissBtn);
		dismissBtn.dispatchEvent({ type: 'click', bubbles: true });
		await flushMicrotasks(8);
		assert.equal(main.inert, true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await flushMicrotasks(4);
		assert.equal(main.inert, false);
		assert.equal(doc.activeElement, menuBtn);

		await unmount(instance);
	})
);
