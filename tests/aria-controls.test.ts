import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as svelte from 'svelte';
import * as svelteAnimate from 'svelte/animate';
import { compile, parse, type AST } from 'svelte/compiler';
import { render } from 'svelte/server';
import ts from 'typescript';
import * as aiConnectionsMod from '../src/lib/ai-connections.ts';
import * as butlerMod from '../src/lib/butler.ts';
import * as syncMod from '../src/lib/client-sync.ts';
import * as clientWorkflowsMod from '../src/lib/client-workflows.ts';
import * as coverUploadMod from '../src/lib/cover-upload.ts';
import * as dataMod from '../src/lib/data.ts';
import * as discoveryMod from '../src/lib/discovery.ts';
import * as domainMod from '../src/lib/domain.ts';
import * as guestMod from '../src/lib/guest-storage.ts';
import * as importSessionMod from '../src/lib/import-session.ts';
import * as workflowsMod from '../src/lib/kitchen-workflows.ts';
import type { SyncConflict } from '../src/lib/offline-sync.ts';
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
const svelteClient = nodeRequire('svelte/internal/client') as Record<string, unknown>;
const svelteServer = nodeRequire('svelte/internal/server') as Record<string, unknown>;

function readRepoFile(relativePath: string): string {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

type HtmlElement = {
	tag: string;
	attrs: Map<string, string>;
	children: Array<HtmlElement | string>;
	parent: HtmlElement | null;
};

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
]);

const HTML_ENTITIES: Record<string, string> = {
	'&quot;': '"',
	'&#39;': "'",
	'&#x27;': "'",
	'&lt;': '<',
	'&gt;': '>',
	'&amp;': '&'
};

function decodeEntities(text: string): string {
	return text.replace(/&(?:quot|#39|#x27|lt|gt|amp);/gi, (entity) => {
		return HTML_ENTITIES[entity.toLowerCase()] ?? entity;
	});
}

function isAsciiWhitespace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isAsciiAlpha(ch: string): boolean {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isTagNameChar(ch: string): boolean {
	return isAsciiAlpha(ch) || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_' || ch === ':';
}

function parseHtml(html: string): HtmlElement {
	const root: HtmlElement = { tag: '#document', attrs: new Map(), children: [], parent: null };
	const stack: HtmlElement[] = [root];
	let pos = 0;

	while (pos < html.length) {
		const lt = html.indexOf('<', pos);
		if (lt === -1) {
			const tail = decodeEntities(html.slice(pos));
			if (tail) stack[stack.length - 1]!.children.push(tail);
			break;
		}

		if (lt > pos) {
			const text = decodeEntities(html.slice(pos, lt));
			if (text) stack[stack.length - 1]!.children.push(text);
		}

		if (html.startsWith('<!--', lt)) {
			const commentEnd = html.indexOf('-->', lt + 4);
			pos = commentEnd === -1 ? html.length : commentEnd + 3;
			continue;
		}

		if (html[lt + 1] === '/') {
			const gt = html.indexOf('>', lt + 2);
			if (gt === -1) break;
			const closeTag = html
				.slice(lt + 2, gt)
				.trim()
				.toLowerCase();
			for (let idx = stack.length - 1; idx > 0; idx -= 1) {
				if (stack[idx]!.tag === closeTag) {
					stack.length = idx;
					break;
				}
			}
			pos = gt + 1;
			continue;
		}

		const firstTagChar = html[lt + 1] ?? '';
		if (!isAsciiAlpha(firstTagChar)) {
			stack[stack.length - 1]!.children.push('<');
			pos = lt + 1;
			continue;
		}

		let cursor = lt + 2;
		while (cursor < html.length && isTagNameChar(html[cursor]!)) {
			cursor += 1;
		}
		const tag = html.slice(lt + 1, cursor).toLowerCase();
		const attrs = new Map<string, string>();
		let selfClosing = VOID_TAGS.has(tag);

		while (cursor < html.length) {
			while (cursor < html.length && isAsciiWhitespace(html[cursor]!)) {
				cursor += 1;
			}
			if (cursor >= html.length) break;

			const ch = html[cursor]!;
			if (ch === '>') {
				cursor += 1;
				break;
			}
			if (ch === '/' && html[cursor + 1] === '>') {
				selfClosing = true;
				cursor += 2;
				break;
			}
			if (ch === '/') {
				cursor += 1;
				continue;
			}

			const nameStart = cursor;
			while (cursor < html.length) {
				const c = html[cursor]!;
				if (isAsciiWhitespace(c) || c === '=' || c === '>' || c === '/') break;
				cursor += 1;
			}
			const attrName = html.slice(nameStart, cursor).toLowerCase();
			while (cursor < html.length && isAsciiWhitespace(html[cursor]!)) {
				cursor += 1;
			}

			let attrValue = '';
			if (html[cursor] === '=') {
				cursor += 1;
				while (cursor < html.length && isAsciiWhitespace(html[cursor]!)) {
					cursor += 1;
				}
				const quote = html[cursor];
				if (quote === '"' || quote === "'") {
					cursor += 1;
					const valStart = cursor;
					const closeQuote = html.indexOf(quote, cursor);
					if (closeQuote === -1) {
						attrValue = html.slice(valStart);
						cursor = html.length;
					} else {
						attrValue = html.slice(valStart, closeQuote);
						cursor = closeQuote + 1;
					}
				} else {
					const valStart = cursor;
					while (cursor < html.length) {
						const c = html[cursor]!;
						if (isAsciiWhitespace(c) || c === '>' || (c === '/' && html[cursor + 1] === '>')) {
							break;
						}
						cursor += 1;
					}
					attrValue = html.slice(valStart, cursor);
				}
			}

			if (attrName) {
				attrs.set(attrName, decodeEntities(attrValue));
			}
		}

		const parent = stack[stack.length - 1]!;
		const element: HtmlElement = {
			tag,
			attrs,
			children: [],
			parent
		};
		parent.children.push(element);
		if (!selfClosing) stack.push(element);
		pos = cursor;
	}

	return root;
}

function hasClass(el: HtmlElement, className: string): boolean {
	return (el.attrs.get('class') ?? '').split(/\s+/).includes(className);
}

function queryAll(
	node: HtmlElement,
	predicate: (el: HtmlElement) => boolean,
	results: HtmlElement[] = []
): HtmlElement[] {
	for (const child of node.children) {
		if (typeof child === 'string') continue;
		if (predicate(child)) results.push(child);
		queryAll(child, predicate, results);
	}
	return results;
}

function collectText(
	node: HtmlElement,
	options: { skipAriaHidden: boolean; skipVisuallyHidden: boolean }
): string {
	if (options.skipAriaHidden && node.attrs.get('aria-hidden') === 'true') return '';
	if (options.skipVisuallyHidden && hasClass(node, 'visually-hidden')) return '';
	let out = '';
	for (const child of node.children) {
		out += typeof child === 'string' ? child : collectText(child, options);
	}
	return out;
}

function accessibleText(el: HtmlElement): string {
	return collectText(el, { skipAriaHidden: true, skipVisuallyHidden: false })
		.replace(/\s+/g, ' ')
		.trim();
}

function visibleText(el: HtmlElement): string {
	return collectText(el, { skipAriaHidden: false, skipVisuallyHidden: true })
		.replace(/\s+/g, ' ')
		.trim();
}

function assertUniqueIds(doc: HtmlElement): Map<string, HtmlElement> {
	const idMap = new Map<string, HtmlElement>();
	for (const el of queryAll(doc, (candidate) => candidate.attrs.has('id'))) {
		const id = el.attrs.get('id')!;
		assert.notEqual(id.trim(), '', `expected non-empty id on <${el.tag}>`);
		assert.equal(idMap.has(id), false, `duplicate DOM id "${id}" rendered`);
		idMap.set(id, el);
	}
	return idMap;
}

function accessibleName(el: HtmlElement, idMap: Map<string, HtmlElement>): string {
	const labelledBy = el.attrs.get('aria-labelledby');
	if (labelledBy !== undefined) {
		const parts = labelledBy
			.split(/\s+/)
			.filter(Boolean)
			.map((id) => {
				const target = idMap.get(id);
				assert.ok(target, `aria-labelledby target "${id}" must exist in rendered DOM`);
				return accessibleText(target);
			});
		return parts.join(' ').replace(/\s+/g, ' ').trim();
	}
	const ariaLabel = el.attrs.get('aria-label');
	if (ariaLabel !== undefined && ariaLabel.trim() !== '') {
		return ariaLabel.trim();
	}
	return accessibleText(el);
}

function compileServerComponent(source: string, filename: string): string {
	const compiled = compile(source, { filename, generate: 'server' });
	assert.equal(
		compiled.warnings.length,
		0,
		`expected 0 Svelte compiler warnings for ${filename}, got: ${JSON.stringify(compiled.warnings)}`
	);
	return ts.transpileModule(compiled.js.code, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
	}).outputText;
}

function loadServerComponent(
	serverJs: string,
	modMap: Record<string, unknown>,
	extraGlobals: Record<string, unknown> = {}
): any {
	const exports: { default?: any } = {};
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			if (id.startsWith('#lib/components/') && id.endsWith('.svelte')) {
				return { __esModule: true, default: noopComponent };
			}
			if (id.startsWith('#lib/')) {
				return nodeRequire(
					new URL(`../src/lib/${id.slice('#lib/'.length)}`, import.meta.url).pathname
				);
			}
			throw new Error(`Unexpected SSR dependency ${id}`);
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
		console,
		encodeURIComponent,
		decodeURIComponent,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		localStorage: {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {}
		},
		window: { location: { assign: () => {}, reload: () => {} } },
		navigator: { onLine: true },
		...extraGlobals
	};
	sandbox.globalThis = sandbox;
	runInNewContext(serverJs, sandbox);
	return exports.default;
}

const noopComponent = () => {};
const iconProxy = new Proxy({}, { get: () => noopComponent });

const toggleSource = readRepoFile('src/lib/components/ToggleButton.svelte');
const disclosureSource = readRepoFile('src/lib/components/DisclosureButton.svelte');
const modalDialogSource = readRepoFile('src/lib/components/ModalDialog.svelte');
const mobileDrawerSource = readRepoFile('src/lib/components/MobileDrawer.svelte');
const formFieldSource = readRepoFile('src/lib/components/FormField.svelte');

const coreModMap: Record<string, unknown> = {
	svelte,
	'svelte/animate': svelteAnimate,
	'svelte/internal/client': svelteClient,
	'svelte/internal/disclose-version': {},
	'svelte/internal/server': svelteServer,
	'@lucide/svelte': iconProxy,
	'#lib/focus.ts': { focusTrap: () => ({}) },
	'#lib/motion.ts': {
		backdropMotion: () => ({}),
		dialogMotion: () => ({}),
		revealMotion: () => ({}),
		fadeMotion: () => ({}),
		motionDuration: () => 0,
		prefersReducedMotion: () => true
	}
};

const ToggleButtonServer = loadServerComponent(
	compileServerComponent(toggleSource, 'ToggleButton.svelte'),
	coreModMap
);
const DisclosureButtonServer = loadServerComponent(
	compileServerComponent(disclosureSource, 'DisclosureButton.svelte'),
	coreModMap
);
const ModalDialogServer = loadServerComponent(
	compileServerComponent(modalDialogSource, 'ModalDialog.svelte'),
	coreModMap
);
const MobileDrawerServer = loadServerComponent(
	compileServerComponent(mobileDrawerSource, 'MobileDrawer.svelte'),
	coreModMap
);
const FormFieldServer = loadServerComponent(
	compileServerComponent(formFieldSource, 'FormField.svelte'),
	coreModMap
);

const baseModMap: Record<string, unknown> = {
	...coreModMap,
	'#lib/components/ModalDialog.svelte': { __esModule: true, default: ModalDialogServer },
	'#lib/components/MobileDrawer.svelte': { __esModule: true, default: MobileDrawerServer },
	'#lib/components/FormField.svelte': { __esModule: true, default: FormFieldServer }
};

function walkAst(node: unknown, visit: (entry: Record<string, any>) => void) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) walkAst(item, visit);
		return;
	}
	const record = node as Record<string, any>;
	if (typeof record.type === 'string') visit(record);
	for (const value of Object.values(record)) {
		if (value && typeof value === 'object') walkAst(value, visit);
	}
}

test('ToggleButton and DisclosureButton compile without warnings and render ARIA state attributes via svelte/server', () => {
	assert.equal(
		compile(toggleSource, { filename: 'ToggleButton.svelte', generate: 'client' }).warnings.length,
		0
	);
	assert.equal(
		compile(disclosureSource, { filename: 'DisclosureButton.svelte', generate: 'client' }).warnings
			.length,
		0
	);

	const unpressedDoc = parseHtml(
		render(ToggleButtonServer, { props: { pressed: false, class: 'pill' } }).body
	);
	const unpressedBtn = queryAll(unpressedDoc, (el) => el.tag === 'button')[0]!;
	assert.equal(unpressedBtn.attrs.get('type'), 'button');
	assert.equal(unpressedBtn.attrs.get('aria-pressed'), 'false');
	assert.equal(unpressedBtn.attrs.has('aria-label'), false);
	assert.equal(unpressedBtn.attrs.get('class'), 'pill');

	const pressedDoc = parseHtml(
		render(ToggleButtonServer, {
			props: { pressed: true, label: 'Dark color mode', type: 'submit' }
		}).body
	);
	const pressedBtn = queryAll(pressedDoc, (el) => el.tag === 'button')[0]!;
	assert.equal(pressedBtn.attrs.get('type'), 'submit');
	assert.equal(pressedBtn.attrs.get('aria-pressed'), 'true');
	assert.equal(pressedBtn.attrs.get('aria-label'), 'Dark color mode');

	const collapsedDoc = parseHtml(
		render(DisclosureButtonServer, { props: { expanded: false } }).body
	);
	const collapsedBtn = queryAll(collapsedDoc, (el) => el.tag === 'button')[0]!;
	assert.equal(collapsedBtn.attrs.get('type'), 'button');
	assert.equal(collapsedBtn.attrs.get('aria-expanded'), 'false');
	assert.equal(collapsedBtn.attrs.has('aria-controls'), false);
	assert.equal(collapsedBtn.attrs.has('aria-label'), false);

	const expandedDoc = parseHtml(
		render(DisclosureButtonServer, {
			props: { expanded: true, controls: 'conflict-panel', label: 'Review changes' }
		}).body
	);
	const expandedBtn = queryAll(expandedDoc, (el) => el.tag === 'button')[0]!;
	assert.equal(expandedBtn.attrs.get('aria-expanded'), 'true');
	assert.equal(expandedBtn.attrs.get('aria-controls'), 'conflict-panel');
	assert.equal(expandedBtn.attrs.get('aria-label'), 'Review changes');
});

test('RecipeDetail renders ToggleButton cooking steps with invariant zero-padded names and preserves fadeMotion on both branches', () => {
	const detailSource = readRepoFile('src/lib/components/RecipeDetail.svelte');
	const detailAst: AST.Root = parse(detailSource, { modern: true });

	// Verify both #if and :else visual spans inside .steps-list retain fadeMotion transitions
	let stepsListNode: Record<string, any> | null = null;
	walkAst(detailAst.fragment, (node) => {
		if (
			node.type === 'RegularElement' &&
			node.name === 'ol' &&
			Array.isArray(node.attributes) &&
			node.attributes.some(
				(attr: any) =>
					attr.type === 'Attribute' &&
					attr.name === 'class' &&
					Array.isArray(attr.value) &&
					attr.value.some((chunk: any) => chunk.data === 'steps-list')
			)
		) {
			stepsListNode = node;
		}
	});
	assert.ok(stepsListNode, 'expected <ol class="steps-list"> in RecipeDetail.svelte');
	let stepIfNode: Record<string, any> | null = null;
	walkAst(stepsListNode, (node) => {
		if (node.type === 'IfBlock' && node.consequent && node.alternate) {
			stepIfNode = node;
		}
	});
	assert.ok(stepIfNode, 'expected {#if ...}{:else}{/if} inside .steps-list ToggleButton');
	const hasFadeMotion = (branch: unknown): boolean => {
		let found = false;
		walkAst(branch, (node) => {
			if (node.type === 'TransitionDirective' && node.name === 'fadeMotion') found = true;
		});
		return found;
	};
	assert.equal(hasFadeMotion((stepIfNode as Record<string, any>).consequent), true);
	assert.equal(hasFadeMotion((stepIfNode as Record<string, any>).alternate), true);

	const RecipeDetailServer = loadServerComponent(
		compileServerComponent(detailSource, 'RecipeDetail.svelte'),
		{
			...baseModMap,
			'#lib/recipe-cover.ts': coverMod,
			'#lib/recipe-draft.ts': recipeDraftMod,
			'#lib/recipe-detail.ts': recipeDetailMod,
			'#lib/components/ToggleButton.svelte': { __esModule: true, default: ToggleButtonServer }
		}
	);

	const recipe: Recipe = {
		id: 'focaccia',
		title: 'Rosemary Focaccia',
		description: 'Crisp olive oil bread.',
		image: '/covers/focaccia.jpg',
		time: 45,
		servings: 4,
		difficulty: 'Easy',
		cuisine: 'Italian',
		tags: ['Bread'],
		ingredients: [{ name: 'Flour', quantity: 500, unit: 'g' }],
		steps: Array.from({ length: 10 }, (_, idx) => `Perform step ${idx + 1}.`),
		nutrition: {
			calories: 310,
			fat: 9,
			saturatedFat: 1,
			sodium: 410,
			carbs: 49,
			fiber: 2,
			sugar: 1,
			protein: 8
		}
	};

	const baseProps = {
		recipe,
		close: () => {},
		save: () => {},
		shop: () => {},
		plan: () => {},
		rate: () => {},
		nutrition: () => {},
		edit: () => {},
		remove: () => {},
		toggleHidden: () => {},
		busy: false
	};

	const unpressedDoc = parseHtml(
		render(RecipeDetailServer, { props: { ...baseProps, completedSteps: [] } }).body
	);
	const unpressedIds = assertUniqueIds(unpressedDoc);
	const unpressedList = queryAll(
		unpressedDoc,
		(el) => el.tag === 'ol' && hasClass(el, 'steps-list')
	)[0];
	assert.ok(unpressedList);
	const unpressedButtons = queryAll(unpressedList, (el) => el.tag === 'button');
	assert.equal(unpressedButtons.length, 10);

	const expectedNames = Array.from(
		{ length: 10 },
		(_, idx) => `Step ${String(idx + 1).padStart(2, '0')}`
	);
	assert.deepEqual(
		unpressedButtons.map((btn) => ({
			type: btn.attrs.get('type'),
			pressed: btn.attrs.get('aria-pressed'),
			visible: visibleText(btn),
			name: accessibleName(btn, unpressedIds)
		})),
		expectedNames.map((name, idx) => ({
			type: 'button',
			pressed: 'false',
			visible: String(idx + 1).padStart(2, '0'),
			name
		}))
	);

	const pressedDoc = parseHtml(
		render(RecipeDetailServer, { props: { ...baseProps, completedSteps: [0, 9] } }).body
	);
	const pressedIds = assertUniqueIds(pressedDoc);
	const pressedList = queryAll(
		pressedDoc,
		(el) => el.tag === 'ol' && hasClass(el, 'steps-list')
	)[0]!;
	const pressedButtons = queryAll(pressedList, (el) => el.tag === 'button');
	assert.equal(pressedButtons.length, 10);
	assert.equal(pressedButtons[0]!.attrs.get('aria-pressed'), 'true');
	assert.equal(hasClass(pressedButtons[0]!, 'done'), true);
	assert.equal(pressedButtons[1]!.attrs.get('aria-pressed'), 'false');
	assert.equal(pressedButtons[9]!.attrs.get('aria-pressed'), 'true');
	assert.deepEqual(
		pressedButtons.map((btn) => accessibleName(btn, pressedIds)),
		expectedNames
	);
});

test('SyncStatus renders DisclosureButton synchronized to reviewOpen without duplicate $effect gating', () => {
	const syncSource = readRepoFile('src/lib/components/SyncStatus.svelte');
	const syncAst: AST.Root = parse(syncSource, { modern: true });

	// Confirm SyncStatus does not duplicate reviewOpen gating with an $effect
	let effectCalls = 0;
	if (syncAst.instance) {
		walkAst(syncAst.instance, (node) => {
			if (
				node.type === 'CallExpression' &&
				node.callee?.type === 'Identifier' &&
				node.callee.name === '$effect'
			) {
				effectCalls += 1;
			}
		});
	}
	assert.equal(effectCalls, 0, 'SyncStatus should gate reviewOpen via $derived alone');

	const scriptEnd = syncSource.indexOf('</script>', syncSource.indexOf('<script lang="ts">'));
	const hookedSyncSource =
		syncSource.slice(0, scriptEnd) +
		`\n\t(globalThis as any).__onSyncStatusInit?.({ setReview: (v: boolean) => { review = v; } });\n` +
		syncSource.slice(scriptEnd);

	const syncServerJs = compileServerComponent(hookedSyncSource, 'SyncStatus.svelte');
	const sampleConflict: SyncConflict = {
		path: 'kitchen.preferences.diet',
		local: 'Vegetarian',
		remote: 'Mediterranean'
	};
	const emptyKitchen = dataMod.createInitialState();

	const renderSync = (opts: { conflicts: SyncConflict[]; initialReview: boolean }) => {
		const SyncStatusServer = loadServerComponent(
			syncServerJs,
			{
				...baseModMap,
				'#lib/components/DisclosureButton.svelte': {
					__esModule: true,
					default: DisclosureButtonServer
				}
			},
			{
				__onSyncStatusInit: (api: { setReview: (v: boolean) => void }) => {
					api.setReview(opts.initialReview);
				}
			}
		);
		return parseHtml(
			render(SyncStatusServer, {
				props: {
					kitchen: emptyKitchen,
					online: true,
					ready: true,
					pending: true,
					syncing: false,
					conflicts: opts.conflicts,
					retry: () => {},
					resolve: () => {},
					exportPending: () => {}
				}
			}).body
		);
	};

	// Collapsed state: aria-expanded="false", no aria-controls, no .sync-review
	const collapsedDoc = renderSync({ conflicts: [sampleConflict], initialReview: false });
	const collapsedIds = assertUniqueIds(collapsedDoc);
	const collapsedBtn = queryAll(collapsedDoc, (el) => el.tag === 'button')[0];
	assert.ok(collapsedBtn);
	assert.equal(collapsedBtn.attrs.get('type'), 'button');
	assert.equal(collapsedBtn.attrs.get('aria-expanded'), 'false');
	assert.equal(collapsedBtn.attrs.has('aria-controls'), false);
	assert.equal(accessibleName(collapsedBtn, collapsedIds), 'Review changes');
	assert.equal(queryAll(collapsedDoc, (el) => hasClass(el, 'sync-review')).length, 0);

	// Expanded state: aria-expanded="true", aria-controls resolves to .sync-review id, invariant label
	const expandedDoc = renderSync({ conflicts: [sampleConflict], initialReview: true });
	const expandedIds = assertUniqueIds(expandedDoc);
	const expandedBtns = queryAll(expandedDoc, (el) => el.tag === 'button');
	const disclosureBtn = expandedBtns[0]!;
	assert.equal(disclosureBtn.attrs.get('aria-expanded'), 'true');
	assert.equal(accessibleName(disclosureBtn, expandedIds), 'Review changes');
	const controlsId = disclosureBtn.attrs.get('aria-controls');
	assert.ok(controlsId, 'expanded DisclosureButton must set aria-controls');
	const reviewPanel = expandedIds.get(controlsId);
	assert.ok(reviewPanel, 'aria-controls target must exist in rendered DOM');
	assert.equal(hasClass(reviewPanel, 'sync-review'), true);

	// Empty conflicts with review=true: single reviewOpen $derived keeps .sync-review closed
	const resolvedDoc = renderSync({ conflicts: [], initialReview: true });
	assertUniqueIds(resolvedDoc);
	assert.equal(queryAll(resolvedDoc, (el) => hasClass(el, 'sync-review')).length, 0);
});

test('+page.svelte renders unique ids, valid aria-labelledby groups, explicit pantry labels, and distinct dark-mode toggle names', () => {
	const rawPageSource = readRepoFile('src/routes/+page.svelte');
	const instanceStart = rawPageSource.indexOf('<script lang="ts">');
	const instanceEnd = rawPageSource.indexOf('</script>', instanceStart);
	const hookedPageSource =
		rawPageSource.slice(0, instanceEnd) +
		`
	(globalThis as any).__onAriaPageInit?.({
		get kitchen() { return kitchen; },
		set kitchen(v: AppState) { kitchen = v; },
		set page(v: string) { page = v; },
		set showHiddenRecipes(v: boolean) { showHiddenRecipes = v; },
		set modal(v: string) { modal = v; },
		set pantryDraft(v: typeof pantryDraft) { pantryDraft = v; }
	});
` +
		rawPageSource.slice(instanceEnd);

	const pageServerJs = compileServerComponent(hookedPageSource, 'src/routes/+page.svelte');

	type PageHarness = {
		kitchen: AppState;
		page: string;
		showHiddenRecipes: boolean;
		modal: string;
		pantryDraft: {
			id: string;
			quantity: number;
			unit: string;
			category: string;
			expires: string;
		} | null;
	};

	const renderPage = (setup: (api: PageHarness) => void) => {
		const PageServer = loadServerComponent(
			pageServerJs,
			{
				...baseModMap,
				'#lib/cover-upload.ts': coverUploadMod,
				'#lib/recipe-cover.ts': coverMod,
				'#lib/planner.ts': plannerMod,
				'#lib/data.ts': dataMod,
				'#lib/domain.ts': domainMod,
				'#lib/import-session.ts': importSessionMod,
				'#lib/kitchen-workflows.ts': workflowsMod,
				'#lib/discovery.ts': discoveryMod,
				'#lib/recipe-collection.ts': recipeCollectionMod,
				'#lib/recipe-detail.ts': recipeDetailMod,
				'#lib/recipe-draft.ts': recipeDraftMod,
				'#lib/recipe-scraper.ts': scraperMod,
				'#lib/butler.ts': butlerMod,
				'#lib/voice-capture.ts': { ...voiceCaptureMod, VoiceCapture: class {} },
				'#lib/voice-config.ts': voiceConfigMod,
				'#lib/ai-connections.ts': aiConnectionsMod,
				'#lib/client-workflows.ts': clientWorkflowsMod,
				'#lib/guest-storage.ts': guestMod,
				'#lib/client-sync.ts': syncMod,
				'#lib/components/ToggleButton.svelte': { __esModule: true, default: ToggleButtonServer },
				'#lib/components/DisclosureButton.svelte': {
					__esModule: true,
					default: DisclosureButtonServer
				},
				'#lib/components/RecipeDetail.svelte': { __esModule: true, default: noopComponent },
				'#lib/components/ButlerChat.svelte': { __esModule: true, default: noopComponent },
				'#lib/components/RecipeEditor.svelte': { __esModule: true, default: noopComponent },
				'#lib/components/SyncStatus.svelte': { __esModule: true, default: noopComponent },
				'#lib/components/AIConnection.svelte': { __esModule: true, default: noopComponent },
				'#lib/components/VoiceSettings.svelte': { __esModule: true, default: noopComponent },
				'#lib/components/RecipeImport.svelte': {
					__esModule: true,
					default: noopComponent,
					emptyImportSession: importSessionMod.emptyImportSession
				}
			},
			{
				__onAriaPageInit: (api: PageHarness) => {
					setup(api);
				}
			}
		);
		return parseHtml(
			render(PageServer, {
				props: { data: { authMode: 'local', loginUrl: null, logoutUrl: null } }
			}).body
		);
	};

	// 1. Discover + Settings modal in light & dark mode: filter group, theme grid, and 3 distinct dark-mode controls
	for (const dark of [false, true]) {
		const settingsDoc = renderPage((api) => {
			api.page = 'discover';
			api.modal = 'settings';
			api.showHiddenRecipes = dark;
			api.kitchen.preferences.dark = dark;
			api.kitchen.preferences.theme = 'nosh';
		});
		const settingsIds = assertUniqueIds(settingsDoc);

		const filterGroup = queryAll(
			settingsDoc,
			(el) => el.attrs.get('role') === 'group' && el.attrs.get('aria-label') === 'Filter recipes'
		)[0];
		assert.ok(filterGroup, 'expected Filter recipes role="group"');
		const filterButtons = queryAll(filterGroup, (el) => el.tag === 'button');
		const hiddenBtn = filterButtons.find((btn) => btn.attrs.get('data-filter') === 'hidden');
		assert.ok(hiddenBtn, 'expected Hidden recipes ToggleButton');
		assert.equal(accessibleName(hiddenBtn, settingsIds), 'Hidden recipes');
		assert.equal(hiddenBtn.attrs.get('aria-pressed'), String(dark));

		const themeGroup = queryAll(
			settingsDoc,
			(el) => el.attrs.get('role') === 'group' && el.attrs.get('aria-label') === 'Color theme'
		)[0];
		assert.ok(themeGroup, 'expected Color theme role="group"');
		const themeButtons = queryAll(themeGroup, (el) => el.tag === 'button');
		assert.ok(themeButtons.length >= 4);
		const noshBtn = themeButtons.find((btn) => accessibleName(btn, settingsIds) === 'nosh');
		assert.ok(noshBtn);
		assert.equal(noshBtn.attrs.get('aria-pressed'), 'true');

		const bottomNav = queryAll(settingsDoc, (el) => hasClass(el, 'bottom-nav'))[0]!;
		const topbarActions = queryAll(settingsDoc, (el) => hasClass(el, 'topbar-actions'))[0]!;
		const settingsSection = queryAll(settingsDoc, (el) => hasClass(el, 'settings-section'))[0]!;

		const sidebarDarkBtn = queryAll(
			bottomNav,
			(el) => el.tag === 'button' && el.attrs.has('aria-pressed')
		)[0]!;
		const topbarDarkBtn = queryAll(
			topbarActions,
			(el) => el.tag === 'button' && el.attrs.has('aria-pressed')
		)[0]!;
		const settingsDarkBtn = queryAll(
			settingsSection,
			(el) => el.tag === 'button' && el.attrs.has('aria-pressed') && hasClass(el, 'secondary')
		)[0]!;

		const darkControlNames = [sidebarDarkBtn, topbarDarkBtn, settingsDarkBtn].map((btn) =>
			accessibleName(btn, settingsIds)
		);
		assert.deepEqual(darkControlNames, ['Dark mode', 'Dark color mode', 'Dark appearance']);
		assert.equal(new Set(darkControlNames).size, 3, 'all three dark-mode names must be distinct');
		for (const btn of [sidebarDarkBtn, topbarDarkBtn, settingsDarkBtn]) {
			assert.equal(btn.attrs.get('aria-pressed'), String(dark));
		}
	}

	// 2. Pantry view (read-only & inline editing): unique ids, expiry/category groups, aria-labelledby targets, explicit <label for> bindings
	const soonDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
	const freshDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
	const samplePantry: AppState['pantry'] = [
		{
			id: 'olive oil#1',
			name: 'Olive oil',
			quantity: 2,
			unit: 'tbsp',
			category: 'Oils',
			expires: soonDate
		},
		{
			id: 'greek-yogurt',
			name: 'Greek yogurt',
			quantity: 500,
			unit: 'g',
			category: 'Dairy',
			expires: freshDate
		}
	];

	const pantryReadOnlyDoc = renderPage((api) => {
		api.page = 'pantry';
		api.kitchen.pantry = structuredClone(samplePantry);
	});
	const readOnlyIds = assertUniqueIds(pantryReadOnlyDoc);

	const expiryGroup = queryAll(
		pantryReadOnlyDoc,
		(el) =>
			hasClass(el, 'expiry-filters') &&
			el.attrs.get('role') === 'group' &&
			el.attrs.get('aria-label') === 'Filter pantry by expiry'
	)[0];
	assert.ok(expiryGroup, 'expected expiry-filters role="group"');
	const expiryButtons = queryAll(expiryGroup, (el) => el.tag === 'button');
	assert.deepEqual(
		expiryButtons.map((btn) => ({
			pressed: btn.attrs.get('aria-pressed'),
			name: accessibleName(btn, readOnlyIds)
		})),
		[
			{ pressed: 'true', name: 'All ingredients, 2 items' },
			{ pressed: 'false', name: 'Expiring soon, 1 item' },
			{ pressed: 'false', name: 'Expired, 0 items' }
		]
	);

	const categoryGroup = queryAll(
		pantryReadOnlyDoc,
		(el) =>
			hasClass(el, 'pantry-categories') &&
			el.attrs.get('role') === 'group' &&
			el.attrs.get('aria-label') === 'Filter pantry by category'
	)[0];
	assert.ok(categoryGroup, 'expected pantry-categories role="group"');
	const categoryButtons = queryAll(categoryGroup, (el) => el.tag === 'button');
	assert.deepEqual(
		categoryButtons.map((btn) => ({
			pressed: btn.attrs.get('aria-pressed'),
			name: accessibleName(btn, readOnlyIds)
		})),
		[
			{ pressed: 'true', name: 'All categories' },
			{ pressed: 'false', name: 'Dairy' },
			{ pressed: 'false', name: 'Oils' }
		]
	);

	const readOnlyActionGroups = queryAll(
		pantryReadOnlyDoc,
		(el) => hasClass(el, 'pantry-row-actions') && el.attrs.get('role') === 'group'
	);
	assert.equal(readOnlyActionGroups.length, 2);
	assert.deepEqual(readOnlyActionGroups.map((group) => accessibleName(group, readOnlyIds)).sort(), [
		'Greek yogurt',
		'Olive oil'
	]);

	// Inline edit open on Olive oil while Greek yogurt remains in read-only mode
	const pantryEditDoc = renderPage((api) => {
		api.page = 'pantry';
		api.kitchen.pantry = structuredClone(samplePantry);
		api.pantryDraft = {
			id: 'olive oil#1',
			quantity: 2,
			unit: 'tbsp',
			category: 'Oils',
			expires: soonDate
		};
	});
	const editIds = assertUniqueIds(pantryEditDoc);

	const editFieldsGroup = queryAll(
		pantryEditDoc,
		(el) => hasClass(el, 'pantry-edit-fields') && el.attrs.get('role') === 'group'
	)[0];
	assert.ok(editFieldsGroup, 'expected .pantry-edit-fields[role="group"]');
	assert.equal(accessibleName(editFieldsGroup, editIds), 'Olive oil');

	const editInputs = queryAll(editFieldsGroup, (el) => el.tag === 'input');
	assert.equal(editInputs.length, 4);

	const labelsByFor = new Map<string, HtmlElement[]>();
	for (const label of queryAll(pantryEditDoc, (el) => el.tag === 'label')) {
		const target = label.attrs.get('for');
		if (!target) continue;
		const list = labelsByFor.get(target) ?? [];
		list.push(label);
		labelsByFor.set(target, list);
	}

	const boundFields = editInputs.map((input) => {
		const inputId = input.attrs.get('id');
		assert.ok(inputId, 'each pantry edit input must have an id');
		const matchingLabels = labelsByFor.get(inputId) ?? [];
		assert.equal(matchingLabels.length, 1, `expected exactly one <label for="${inputId}">`);
		const label = matchingLabels[0]!;
		assert.equal(hasClass(label, 'pantry-field-label'), true);
		return {
			type: input.attrs.get('type'),
			visibleLabel: visibleText(label),
			accessibleLabel: accessibleText(label)
		};
	});

	assert.deepEqual(boundFields, [
		{ type: 'number', visibleLabel: 'Amount', accessibleLabel: 'Amount of Olive oil' },
		{ type: 'text', visibleLabel: 'Unit', accessibleLabel: 'Unit for Olive oil' },
		{ type: 'text', visibleLabel: 'Category', accessibleLabel: 'Category for Olive oil' },
		{ type: 'date', visibleLabel: 'Best before', accessibleLabel: 'Best before for Olive oil' }
	]);
});
