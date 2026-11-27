import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import * as svelte from 'svelte';
import * as svelteAnimate from 'svelte/animate';
import * as aiConnectionsMod from '../src/lib/ai-connections.ts';
import * as butlerMod from '../src/lib/butler.ts';
import * as butlerChatMod from '../src/lib/butler-chat.ts';
import * as syncMod from '../src/lib/client-sync.ts';
import * as clientWorkflowsMod from '../src/lib/client-workflows.ts';
import * as coverUploadMod from '../src/lib/cover-upload.ts';
import { COVER_PATH } from '../src/lib/cover-upload.ts';
import * as dataMod from '../src/lib/data.ts';
import { createInitialState } from '../src/lib/data.ts';
import * as discoveryMod from '../src/lib/discovery.ts';
import * as domainMod from '../src/lib/domain.ts';
import * as formValidationMod from '../src/lib/form-validation.ts';
import {
	describeBy,
	fieldAria,
	fieldIds,
	focusFirstInvalid,
	validateEmail,
	validateInviteCode,
	validateLeftoverServings,
	validateMealDate,
	validatePantryInput,
	validatePassword,
	validatePlannedServings,
	validateRecipeDraftFields,
	validateRecipeLink,
	validateRegistrationName
} from '../src/lib/form-validation.ts';
import * as guestMod from '../src/lib/guest-storage.ts';
import * as kitchenExportMod from '../src/lib/kitchen-export.ts';
import * as importSessionMod from '../src/lib/import-session.ts';
import * as workflowsMod from '../src/lib/kitchen-workflows.ts';
import * as plannerMod from '../src/lib/planner.ts';
import * as recipeCollectionMod from '../src/lib/recipe-collection.ts';
import * as coverMod from '../src/lib/recipe-cover.ts';
import * as recipeDetailMod from '../src/lib/recipe-detail.ts';
import * as recipeDraftMod from '../src/lib/recipe-draft.ts';
import * as scraperMod from '../src/lib/recipe-scraper.ts';
import * as searchPickerMod from '../src/lib/search-picker.ts';
import * as statusMod from '../src/lib/status.ts';
import type { AppState, Recipe, User } from '../src/lib/types.ts';
import * as voiceCaptureMod from '../src/lib/voice-capture.ts';
import * as voiceConfigMod from '../src/lib/voice-config.ts';

const nodeRequire = createRequire(import.meta.url);
const svelteClient = nodeRequire('svelte/internal/client') as {
	effect_root: (fn: () => void) => () => void;
};
const svelteServer = nodeRequire('svelte/internal/server') as Record<string, unknown>;

test('fieldIds and fieldAria generate deterministic IDs and preserve helper IDs when invalid', () => {
	assert.deepEqual(fieldIds('plan-servings'), {
		id: 'plan-servings',
		labelId: 'plan-servings-label',
		helpId: 'plan-servings-help',
		errorId: 'plan-servings-error'
	});

	assert.equal(describeBy('a', undefined, false, 'b a', 'c'), 'a b c');
	assert.equal(describeBy(undefined, '', false), undefined);

	const validWithHelp = fieldAria('plan-servings', { hasHelp: true });
	assert.deepEqual(validWithHelp.props, {
		id: 'plan-servings',
		'aria-describedby': 'plan-servings-help',
		'aria-invalid': 'false'
	});

	const invalidWithHelp = fieldAria('plan-servings', {
		hasHelp: true,
		helpIds: ['extra-help'],
		error: 'Enter a whole number from 1 to 10,000 servings.'
	});
	assert.deepEqual(invalidWithHelp.props, {
		id: 'plan-servings',
		'aria-describedby': 'plan-servings-help extra-help plan-servings-error',
		'aria-invalid': 'true'
	});

	const serverErrorLinked = fieldAria('auth-email', {
		errorId: 'auth-form-error',
		invalid: true
	});
	assert.deepEqual(serverErrorLinked.props, {
		id: 'auth-email',
		'aria-describedby': 'auth-form-error',
		'aria-invalid': 'true'
	});

	const inlineAndExternal = fieldAria('household-join-code', {
		hasHelp: true,
		error: 'Enter an invitation code to join a household.',
		errorId: 'household-form-error',
		invalid: true
	});
	assert.equal(inlineAndExternal.errorId, 'household-join-code-error');
	assert.deepEqual(inlineAndExternal.props, {
		id: 'household-join-code',
		'aria-describedby': 'household-join-code-help household-join-code-error household-form-error',
		'aria-invalid': 'true'
	});
});

test('meal, leftover, pantry, invite, and auth validators enforce exact bounds', () => {
	assert.equal(validateMealDate('2026-11-22'), '');
	assert.match(validateMealDate(''), /Choose a date/);
	assert.match(validateMealDate('not-a-date'), /Choose a date/);

	assert.equal(validatePlannedServings(1), '');
	assert.equal(validatePlannedServings(24), '');
	assert.equal(validatePlannedServings(10_000), '');
	assert.match(validatePlannedServings(0), /1 to 10,000/);
	assert.match(validatePlannedServings(10_001), /1 to 10,000/);
	assert.match(validatePlannedServings(2.5), /1 to 10,000/);
	assert.match(validatePlannedServings(null), /1 to 10,000/);

	assert.equal(validateLeftoverServings(0, 4), '');
	assert.equal(validateLeftoverServings(4, 4), '');
	assert.match(validateLeftoverServings(-1, 4), /0 to 4/);
	assert.match(validateLeftoverServings(5, 4), /0 to 4/);
	assert.match(validateLeftoverServings(1.5, 4), /0 to 4/);

	assert.equal(validateRecipeLink(''), '');
	assert.equal(validateRecipeLink('https://example.com/recipe'), '');
	assert.equal(validateRecipeLink('http://example.com/recipe'), '');
	assert.match(validateRecipeLink('ftp://example.com/recipe'), /http:\/\/ or https:\/\//);
	assert.match(validateRecipeLink('not-a-link'), /http:\/\/ or https:\/\//);

	assert.equal(validateRegistrationName('Ada Lovelace'), '');
	assert.match(validateRegistrationName('A'), /2 to 80/);

	// Strict email check applies to register and recover, while login only requires non-empty input.
	assert.equal(validateEmail('cook@example.com'), '');
	assert.equal(validateEmail('cook@example.com', 'register'), '');
	assert.equal(validateEmail('cook@example.com', 'recover'), '');
	assert.match(validateEmail('invalid-email'), /valid email/);
	assert.match(validateEmail('chef@localhost', 'register'), /valid email/);
	assert.match(validateEmail('chef@localhost', 'recover'), /valid email/);
	assert.equal(validateEmail('chef@localhost', 'login'), '');
	assert.equal(validateEmail('legacy_account@internal', 'login'), '');
	assert.match(validateEmail('   ', 'login'), /Enter your email address/);

	assert.equal(validatePassword('tencharpwd', 'register'), '');
	assert.equal(validatePassword('tencharpwd', 'reset'), '');
	assert.match(validatePassword('short1234', 'register'), /10 and 128/);
	assert.match(validatePassword('short1234', 'reset'), /10 and 128/);
	assert.equal(validatePassword('short', 'login'), '');
	assert.match(validatePassword('', 'login'), /Enter your password/);
	assert.match(validatePassword('', 'delete'), /confirm account deletion/);

	assert.equal(validatePantryInput('2 eggs, spinach'), '');
	assert.equal(validatePantryInput('1 1/2 cups milk [Dairy, Eggs]'), '');
	assert.match(validatePantryInput(' , \n ; '), /at least one ingredient/);
	assert.match(validatePantryInput('0 g flour'), /quantity above zero/);

	assert.equal(validateInviteCode('INV-123'), '');
	assert.match(validateInviteCode('   '), /invitation code/);
});

test('validateRecipeDraftFields reports per-field errors including nutrition and image URLs', () => {
	const base = structuredClone(createInitialState().recipes[0]);
	const clean = validateRecipeDraftFields(base, {
		tagsText: base.tags.join(', '),
		checkImage: true,
		coverPathPattern: COVER_PATH
	});
	assert.equal(clean.hasErrors, false);
	assert.equal(clean.summary, '');

	const broken = structuredClone(base);
	broken.title = '   ';
	broken.time = 0;
	broken.servings = 0;
	broken.image = 'http://insecure.example/photo.jpg';
	broken.ingredients[0] = { name: '', quantity: -2, unit: '' };
	broken.steps[0] = '   ';
	broken.nutrition.calories = -10;
	broken.nutrition.sodium = Number.NaN;

	const result = validateRecipeDraftFields(broken, {
		tagsText: Array.from({ length: 31 }, (_, i) => `tag-${i}`).join(', '),
		checkImage: true,
		coverPathPattern: COVER_PATH
	});
	assert.equal(result.hasErrors, true);
	assert.equal(result.hasNutritionErrors, true);
	assert.match(result.title, /recipe title/);
	assert.match(result.time, /cooking time/);
	assert.match(result.servings, /servings/);
	assert.match(result.image, /HTTPS image URL/);
	assert.match(result.tags, /30 tags/);
	assert.match(result.ingredients[0].name ?? '', /ingredient 1/i);
	assert.match(result.ingredients[0].quantity ?? '', /ingredient 1/i);
	assert.match(result.ingredients[0].unit ?? '', /ingredient 1/i);
	assert.match(result.steps[0], /step 1/i);
	assert.match(result.nutrition.calories ?? '', /calories/i);
	assert.match(result.nutrition.sodium ?? '', /sodium/i);
	assert.equal(result.nutrition.protein, undefined);
	assert.match(result.summary, /^Fix \d+ fields before saving:/);
});

test('focusFirstInvalid expands closed ancestor details disclosures, scrolls the field row, and focuses with preventScroll', () => {
	let focusedOptions: FocusOptions | undefined;
	let scrolledBlock: ScrollLogicalPosition | undefined;
	const outerDetails: Record<string, unknown> = { open: false, parentElement: null };
	const innerDetails: Record<string, unknown> = {
		open: false,
		parentElement: {
			closest: (selector: string) => (selector === 'details' ? outerDetails : null)
		}
	};
	const fieldRow = {
		scrollIntoView: (opts?: ScrollIntoViewOptions) => {
			scrolledBlock = opts?.block;
		}
	};
	const invalidInput = {
		closest: (selector: string) => {
			if (selector === 'details') return innerDetails;
			if (selector.includes('.field')) return fieldRow;
			return null;
		},
		scrollIntoView: () => {},
		focus: (opts?: FocusOptions) => {
			focusedOptions = opts;
		}
	} as unknown as HTMLElement;

	const container = {
		querySelector: () => invalidInput
	} as unknown as ParentNode;

	const target = focusFirstInvalid(container);
	assert.equal(target, invalidInput);
	assert.equal(innerDetails.open, true);
	assert.equal(outerDetails.open, true);
	assert.equal(scrolledBlock, 'nearest');
	assert.deepEqual(focusedOptions, { preventScroll: true });
});

// --- SSR compilation & DOM/ARIA resolution helpers ---

const noopComponent = Object.assign(() => {}, {
	__esModule: true,
	default: () => {}
});
const iconProxy = new Proxy({}, { get: () => noopComponent });

function injectScriptHook(svelteSource: string, hookCode: string): string {
	const instanceStart = svelteSource.indexOf('<script lang="ts">');
	assert.notEqual(instanceStart, -1, 'expected instance <script lang="ts">');
	const instanceEnd = svelteSource.indexOf('</script>', instanceStart);
	assert.notEqual(instanceEnd, -1, 'expected closing </script>');
	return svelteSource.slice(0, instanceEnd) + `\n${hookCode}\n` + svelteSource.slice(instanceEnd);
}

function compileServerModule(
	filename: string,
	source: string,
	extraModules: Record<string, unknown> = {}
): Record<string, any> {
	const compiled = compile(source, { filename, generate: 'server' }).js.code;
	const cjs = ts.transpileModule(compiled, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
	}).outputText;
	const modMap: Record<string, unknown> = {
		svelte,
		'svelte/animate': svelteAnimate,
		'svelte/internal/client': svelteClient,
		'svelte/internal/disclose-version': {},
		'svelte/internal/server': svelteServer,
		'@lucide/svelte': iconProxy,
		'./ToggleButton.svelte': noopComponent,
		'./StatusRegion.svelte': noopComponent,
		'#lib/components/ToggleButton.svelte': noopComponent,
		'#lib/components/DisclosureButton.svelte': noopComponent,
		'#lib/components/StatusRegion.svelte': noopComponent,
		'#lib/cover-upload.ts': coverUploadMod,
		'#lib/recipe-cover.ts': coverMod,
		'#lib/focus.ts': { focusTrap: () => ({}) },
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
		'#lib/kitchen-workflows.ts': workflowsMod,
		'#lib/kitchen-export.ts': kitchenExportMod,
		'#lib/discovery.ts': discoveryMod,
		'#lib/recipe-collection.ts': recipeCollectionMod,
		'#lib/recipe-detail.ts': recipeDetailMod,
		'#lib/recipe-draft.ts': recipeDraftMod,
		'#lib/recipe-scraper.ts': scraperMod,
		'#lib/search-picker.ts': searchPickerMod,
		'#lib/status.ts': statusMod,
		'#lib/butler.ts': butlerMod,
		'#lib/butler-chat.ts': butlerChatMod,
		'#lib/voice-capture.ts': { ...voiceCaptureMod, VoiceCapture: class {} },
		'#lib/voice-config.ts': voiceConfigMod,
		'#lib/ai-connections.ts': aiConnectionsMod,
		'#lib/client-workflows.ts': clientWorkflowsMod,
		'#lib/guest-storage.ts': guestMod,
		'#lib/client-sync.ts': syncMod,
		...extraModules
	};
	const exports: Record<string, any> = {};
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			throw new Error(`Unexpected module import ${id} while compiling ${filename}`);
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
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		localStorage: makeMemoryStorage(),
		window: { location: { assign: () => {}, reload: () => {} } },
		navigator: { onLine: true }
	};
	sandbox.globalThis = sandbox;
	runInNewContext(cjs, sandbox);
	return { exports, sandbox };
}

function makeMemoryStorage() {
	const store = new Map<string, string>();
	return new Proxy(store, {
		get(target, prop) {
			if (prop === 'getItem') return (key: string) => target.get(key) ?? null;
			if (prop === 'setItem') return (key: string, value: string) => void target.set(key, value);
			if (prop === 'removeItem') return (key: string) => void target.delete(key);
			if (prop === 'clear') return () => target.clear();
			if (typeof prop === 'string') return target.get(prop);
			return undefined;
		},
		ownKeys(target) {
			return [...target.keys()];
		},
		getOwnPropertyDescriptor(target, prop) {
			if (typeof prop === 'string' && target.has(prop)) {
				return { enumerable: true, configurable: true, value: target.get(prop) };
			}
			return undefined;
		}
	});
}

type ParsedTag = {
	tag: string;
	attrs: Record<string, string>;
};

type HtmlToken =
	| { kind: 'open'; tag: string; attrs: Record<string, string>; selfClosing: boolean }
	| { kind: 'close'; tag: string }
	| { kind: 'text'; text: string };

const VOID_HTML_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source']);

function isAsciiAlpha(ch: string | undefined): boolean {
	if (!ch) return false;
	const code = ch.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(ch: string | undefined): boolean {
	if (!ch) return false;
	if (isAsciiAlpha(ch)) return true;
	const code = ch.charCodeAt(0);
	return (code >= 48 && code <= 57) || ch === '-';
}

function isWhitespaceChar(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function tokenizeHtml(html: string): HtmlToken[] {
	const tokens: HtmlToken[] = [];
	let i = 0;
	while (i < html.length) {
		if (html.startsWith('<!--', i)) {
			const endComment = html.indexOf('-->', i + 4);
			i = endComment === -1 ? html.length : endComment + 3;
			continue;
		}
		if (html[i] === '<') {
			if (html[i + 1] === '/' && isAsciiAlpha(html[i + 2])) {
				const closeGt = html.indexOf('>', i + 2);
				if (closeGt === -1) break;
				const closeName = html
					.slice(i + 2, closeGt)
					.trim()
					.toLowerCase();
				tokens.push({ kind: 'close', tag: closeName });
				i = closeGt + 1;
				continue;
			}
			if (isAsciiAlpha(html[i + 1])) {
				let cursor = i + 1;
				while (cursor < html.length && isTagNameChar(html[cursor])) cursor += 1;
				const tag = html.slice(i + 1, cursor).toLowerCase();
				const attrs: Record<string, string> = {};
				let selfClosing = false;
				while (cursor < html.length) {
					while (cursor < html.length && isWhitespaceChar(html[cursor])) cursor += 1;
					if (cursor >= html.length) break;
					if (html[cursor] === '>') {
						cursor += 1;
						break;
					}
					if (html[cursor] === '/' && html[cursor + 1] === '>') {
						selfClosing = true;
						cursor += 2;
						break;
					}
					const nameStart = cursor;
					while (
						cursor < html.length &&
						!isWhitespaceChar(html[cursor]) &&
						html[cursor] !== '=' &&
						html[cursor] !== '>' &&
						html[cursor] !== '/'
					) {
						cursor += 1;
					}
					if (cursor === nameStart) {
						cursor += 1;
						continue;
					}
					const attrName = html.slice(nameStart, cursor).toLowerCase();
					while (cursor < html.length && isWhitespaceChar(html[cursor])) cursor += 1;
					let attrValue = '';
					if (html[cursor] === '=') {
						cursor += 1;
						while (cursor < html.length && isWhitespaceChar(html[cursor])) cursor += 1;
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
							while (
								cursor < html.length &&
								!isWhitespaceChar(html[cursor]) &&
								html[cursor] !== '>'
							) {
								cursor += 1;
							}
							attrValue = html.slice(valStart, cursor);
						}
					}
					attrs[attrName] = attrValue;
				}
				tokens.push({ kind: 'open', tag, attrs, selfClosing });
				i = cursor;
				continue;
			}
			tokens.push({ kind: 'text', text: '<' });
			i += 1;
			continue;
		}
		const nextLt = html.indexOf('<', i);
		const end = nextLt === -1 ? html.length : nextLt;
		tokens.push({ kind: 'text', text: html.slice(i, end) });
		i = end;
	}
	return tokens;
}

function parseOpeningTags(html: string): ParsedTag[] {
	const tags: ParsedTag[] = [];
	for (const token of tokenizeHtml(html)) {
		if (token.kind === 'open') {
			tags.push({ tag: token.tag, attrs: token.attrs });
		}
	}
	return tags;
}

function findElementTextById(html: string, targetId: string): string | null {
	const tokens = tokenizeHtml(html);
	const startIdx = tokens.findIndex(
		(token) => token.kind === 'open' && token.attrs.id === targetId
	);
	if (startIdx === -1) return null;
	const openToken = tokens[startIdx];
	if (openToken.kind !== 'open') return null;
	if (openToken.selfClosing || VOID_HTML_TAGS.has(openToken.tag)) return '';

	let depth = 1;
	const chunks: string[] = [];
	for (let idx = startIdx + 1; idx < tokens.length; idx += 1) {
		const token = tokens[idx];
		if (token.kind === 'open') {
			if (!token.selfClosing && !VOID_HTML_TAGS.has(token.tag) && token.tag === openToken.tag) {
				depth += 1;
			}
		} else if (token.kind === 'close') {
			if (token.tag === openToken.tag) {
				depth -= 1;
				if (depth === 0) {
					return chunks.join(' ').replace(/\s+/g, ' ').trim();
				}
			}
		} else {
			chunks.push(token.text);
		}
	}
	return null;
}

function getTagById(tags: ParsedTag[], id: string): ParsedTag | undefined {
	return tags.find((entry) => entry.attrs.id === id);
}

function assertValidRenderedAccessibility(html: string, contextLabel: string): ParsedTag[] {
	const tags = parseOpeningTags(html);
	const ids = new Set<string>();
	for (const entry of tags) {
		if ('id' in entry.attrs) {
			assert.notEqual(entry.attrs.id.trim(), '', `${contextLabel}: encountered empty id attribute`);
			assert.equal(
				ids.has(entry.attrs.id),
				false,
				`${contextLabel}: duplicate id="${entry.attrs.id}" in rendered HTML`
			);
			ids.add(entry.attrs.id);
		}
	}

	const controlTags = new Set(['input', 'select', 'textarea']);
	for (const entry of tags) {
		if (entry.tag === 'label' && entry.attrs.for) {
			const target = getTagById(tags, entry.attrs.for);
			assert.ok(
				target && controlTags.has(target.tag),
				`${contextLabel}: <label for="${entry.attrs.for}"> did not resolve to a rendered form control`
			);
		}
		if ('aria-describedby' in entry.attrs) {
			const tokens = entry.attrs['aria-describedby'].trim().split(/\s+/).filter(Boolean);
			assert.ok(
				tokens.length > 0,
				`${contextLabel}: empty aria-describedby on <${entry.tag} id="${entry.attrs.id ?? ''}">`
			);
			for (const token of tokens) {
				assert.ok(
					ids.has(token),
					`${contextLabel}: aria-describedby token "${token}" on <${entry.tag} id="${entry.attrs.id ?? ''}"> did not resolve to any rendered id`
				);
				const text = findElementTextById(html, token);
				assert.ok(
					text !== null && text.length > 0,
					`${contextLabel}: aria-describedby target #${token} had empty text`
				);
			}
		}
	}
	return tags;
}

const formFieldMod = compileServerModule(
	'src/lib/components/FormField.svelte',
	readFileSync('src/lib/components/FormField.svelte', 'utf8')
).exports;

const searchPickerSsrMod = compileServerModule(
	'src/lib/components/SearchPicker.svelte',
	readFileSync('src/lib/components/SearchPicker.svelte', 'utf8')
).exports;

const voiceSettingsSsrMod = compileServerModule(
	'src/lib/components/VoiceSettings.svelte',
	readFileSync('src/lib/components/VoiceSettings.svelte', 'utf8'),
	{ './FormField.svelte': formFieldMod }
).exports;

const aiConnectionSsrMod = compileServerModule(
	'src/lib/components/AIConnection.svelte',
	readFileSync('src/lib/components/AIConnection.svelte', 'utf8'),
	{
		'./FormField.svelte': formFieldMod,
		'./SearchPicker.svelte': searchPickerSsrMod
	}
).exports;

test('rendered components resolve every aria-describedby and label[for] without duplicate IDs', () => {
	const sampleRecipe = structuredClone(createInitialState().recipes[0]);

	// 1. RecipeDetail across recipe/nutrition tabs and valid/invalid servings
	const rawDetail = readFileSync('src/lib/components/RecipeDetail.svelte', 'utf8');
	const hookedDetail = injectScriptHook(
		rawDetail,
		`(globalThis as any).__onDetailInit?.({ setTab(next: 'recipe' | 'nutrition') { tab = next; } });`
	);
	const detailCompiled = compileServerModule(
		'src/lib/components/RecipeDetail.svelte',
		hookedDetail
	);
	const detailBaseProps = {
		recipe: sampleRecipe,
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

	detailCompiled.sandbox.__onDetailInit = undefined;
	const detailValidHtml = render(detailCompiled.exports.default, {
		props: { ...detailBaseProps, initialServings: 4 }
	}).body;
	const detailValidTags = assertValidRenderedAccessibility(detailValidHtml, 'RecipeDetail valid');
	const validServingsInput = getTagById(detailValidTags, 'recipe-servings');
	assert.equal(validServingsInput?.attrs['aria-invalid'], 'false');
	assert.equal(validServingsInput?.attrs['aria-describedby'], 'servings-help');

	const detailInvalidHtml = render(detailCompiled.exports.default, {
		props: { ...detailBaseProps, initialServings: 0 }
	}).body;
	const detailInvalidTags = assertValidRenderedAccessibility(
		detailInvalidHtml,
		'RecipeDetail invalid servings'
	);
	const invalidServingsInput = getTagById(detailInvalidTags, 'recipe-servings');
	assert.equal(invalidServingsInput?.attrs['aria-invalid'], 'true');
	assert.equal(
		invalidServingsInput?.attrs['aria-describedby'],
		'servings-help recipe-servings-error'
	);
	assert.equal(getTagById(detailInvalidTags, 'recipe-servings-error')?.attrs.role, 'alert');

	detailCompiled.sandbox.__onDetailInit = (api: {
		setTab: (t: 'recipe' | 'nutrition') => void;
	}) => {
		api.setTab('nutrition');
	};
	const detailNutritionHtml = render(detailCompiled.exports.default, {
		props: { ...detailBaseProps, initialServings: 4 }
	}).body;
	assertValidRenderedAccessibility(detailNutritionHtml, 'RecipeDetail nutrition tab');

	// 2. RecipeEditor clean & submitted-invalid states
	const rawEditor = readFileSync('src/lib/components/RecipeEditor.svelte', 'utf8');
	const hookedEditor = injectScriptHook(
		rawEditor,
		`(globalThis as any).__onEditorInit?.({
			submitInvalid() {
				submitted = true;
				tagsText = Array.from({ length: 31 }, (_, i) => 'tag-' + i).join(', ');
			}
		});`
	);
	const editorCompiled = compileServerModule(
		'src/lib/components/RecipeEditor.svelte',
		hookedEditor,
		{ './FormField.svelte': formFieldMod }
	);
	editorCompiled.sandbox.__onEditorInit = undefined;
	const editorCleanHtml = render(editorCompiled.exports.default, {
		props: {
			recipe: sampleRecipe,
			mode: 'edit',
			canUploadCover: true,
			cancel: () => {},
			save: () => {}
		}
	}).body;
	assertValidRenderedAccessibility(editorCleanHtml, 'RecipeEditor clean');

	const brokenRecipe = structuredClone(sampleRecipe);
	brokenRecipe.title = '   ';
	brokenRecipe.time = 0;
	brokenRecipe.servings = 0;
	brokenRecipe.image = 'http://insecure.example/cover.jpg';
	brokenRecipe.ingredients = [{ name: '', quantity: 0, unit: '' }];
	brokenRecipe.steps = ['   '];
	brokenRecipe.nutrition.calories = -5;
	editorCompiled.sandbox.__onEditorInit = (api: { submitInvalid: () => void }) =>
		api.submitInvalid();
	const editorInvalidHtml = render(editorCompiled.exports.default, {
		props: {
			recipe: brokenRecipe,
			mode: 'create',
			canUploadCover: true,
			cancel: () => {},
			save: () => {}
		}
	}).body;
	const editorInvalidTags = assertValidRenderedAccessibility(
		editorInvalidHtml,
		'RecipeEditor invalid'
	);
	assert.equal(getTagById(editorInvalidTags, 'editor-title')?.attrs['aria-invalid'], 'true');
	assert.equal(
		getTagById(editorInvalidTags, 'editor-tags')?.attrs['aria-describedby'],
		'editor-tags-help editor-tags-error'
	);
	assert.equal(
		getTagById(editorInvalidTags, 'editor-ingredient-0-name')?.attrs['aria-invalid'],
		'true'
	);
	assert.equal(getTagById(editorInvalidTags, 'editor-step-0')?.attrs['aria-invalid'], 'true');
	assert.equal(
		getTagById(editorInvalidTags, 'editor-nutrition-calories')?.attrs['aria-invalid'],
		'true'
	);

	// 3. RecipeImport capture & draft-review states (including unique #recipe-import-title)
	const rawImport = readFileSync('src/lib/components/RecipeImport.svelte', 'utf8');
	const hookedImport = injectScriptHook(
		rawImport,
		`(globalThis as any).__onImportInit?.({
			markCaptureInvalid() { captureSubmitted = true; error = 'Could not read that link.'; },
			markDraftInvalid() { draftSubmitted = true; }
		});`
	);
	const importCompiled = compileServerModule(
		'src/lib/components/RecipeImport.svelte',
		hookedImport,
		{ './FormField.svelte': formFieldMod }
	);
	importCompiled.sandbox.__onImportInit = (api: { markCaptureInvalid: () => void }) =>
		api.markCaptureInvalid();
	const importCaptureHtml = render(importCompiled.exports.default, {
		props: {
			session: {
				...importCompiled.exports.emptyImportSession(),
				url: 'ftp://invalid.example/recipe'
			},
			capture: async () => null,
			save: () => {},
			dictate: () => {}
		}
	}).body;
	const importCaptureTags = assertValidRenderedAccessibility(
		importCaptureHtml,
		'RecipeImport capture invalid'
	);
	assert.equal(
		importCaptureTags.filter((t) => t.attrs.id === 'recipe-import-title').length,
		1,
		'expected exactly one #recipe-import-title in capture view'
	);
	assert.equal(
		getTagById(importCaptureTags, 'import-recipe-url')?.attrs['aria-describedby'],
		'import-source-help import-link-help import-recipe-url-error'
	);

	importCompiled.sandbox.__onImportInit = (api: { markDraftInvalid: () => void }) =>
		api.markDraftInvalid();
	const importDraftHtml = render(importCompiled.exports.default, {
		props: {
			session: {
				...importCompiled.exports.emptyImportSession(),
				draft: structuredClone(brokenRecipe),
				reviewingDraft: true
			},
			capture: async () => null,
			save: () => {},
			dictate: () => {}
		}
	}).body;
	const importDraftTags = assertValidRenderedAccessibility(
		importDraftHtml,
		'RecipeImport draft invalid'
	);
	assert.equal(
		importDraftTags.filter((t) => t.attrs.id === 'recipe-import-title').length,
		1,
		'expected exactly one #recipe-import-title in draft review view'
	);
	assert.equal(getTagById(importDraftTags, 'import-title')?.attrs['aria-invalid'], 'true');

	// 4. VoiceSettings & AIConnection
	assertValidRenderedAccessibility(
		render(voiceSettingsSsrMod.default, {
			props: { provider: 'auto', model: '', apiKey: '', localAvailable: false }
		}).body,
		'VoiceSettings signed-out auto'
	);
	assertValidRenderedAccessibility(
		render(voiceSettingsSsrMod.default, {
			props: {
				provider: 'local',
				model: '',
				apiKey: '',
				localAvailable: false,
				userId: 'user-1'
			}
		}).body,
		'VoiceSettings local unavailable'
	);
	assertValidRenderedAccessibility(
		render(aiConnectionSsrMod.default, {
			props: {
				preferences: structuredClone(createInitialState().preferences),
				apiKey: '',
				providers: [
					{
						id: 'openai',
						name: 'OpenAI',
						kind: 'api-key',
						configured: false,
						models: [{ id: 'gpt-5', name: 'GPT-5' }]
					}
				],
				accountModels: [],
				chatGPT: { configured: true, mode: 'popup', accounts: [] },
				signedIn: true,
				managedAuth: false,
				busy: false,
				loading: false,
				catalogError: 'Could not refresh model list.',
				authorizationUrl: '',
				device: null,
				oncancel: () => {},
				oncopycode: () => {},
				onselect: () => {},
				onaccount: () => {},
				onconnect: () => {},
				ondisconnect: () => {},
				onrefresh: () => {},
				onsignin: () => {}
			}
		}).body,
		'AIConnection api-key with catalog error'
	);
	assertValidRenderedAccessibility(
		render(aiConnectionSsrMod.default, {
			props: {
				preferences: structuredClone(createInitialState().preferences),
				apiKey: '',
				providers: [],
				accountModels: [],
				chatGPT: {
					configured: true,
					mode: 'device',
					host: { model: 'gpt-5.4' },
					accounts: []
				},
				signedIn: true,
				managedAuth: false,
				busy: false,
				loading: false,
				catalogError: '',
				authorizationUrl: '',
				device: null,
				oncancel: () => {},
				oncopycode: () => {},
				onselect: () => {},
				onaccount: () => {},
				onconnect: () => {},
				ondisconnect: () => {},
				onrefresh: () => {},
				onsignin: () => {}
			}
		}).body,
		'AIConnection host default active'
	);
});

// --- +page.svelte modal accessibility & end-to-end login/onboarding harness ---

const rawPageSource = readFileSync('src/routes/+page.svelte', 'utf8');
const pageHookCode = `
	(globalThis as any).__onPageFormInit?.({
		get kitchen() { return kitchen; },
		set kitchen(value: AppState) { kitchen = value; },
		get user() { return user; },
		set user(value: User | null) { user = value; },
		get modal() { return modal; },
		set modal(value: string) { modal = value; },
		get authMode() { return authMode; },
		set authMode(value: string) { authMode = value; },
		get name() { return name; },
		set name(value: string) { name = value; },
		get email() { return email; },
		set email(value: string) { email = value; },
		get password() { return password; },
		set password(value: string) { password = value; },
		get deletePassword() { return deletePassword; },
		set deletePassword(value: string) { deletePassword = value; },
		get error() { return error; },
		set error(value: string) { error = value; },
		get formSubmitted() { return formSubmitted; },
		set formSubmitted(value: boolean) { formSubmitted = value; },
		get pantryInput() { return pantryInput; },
		set pantryInput(value: string) { pantryInput = value; },
		get joinCode() { return joinCode; },
		set joinCode(value: string) { joinCode = value; },
		get inviteCode() { return inviteCode; },
		set inviteCode(value: string) { inviteCode = value; },
		get canManageHousehold() { return canManageHousehold; },
		set canManageHousehold(value: boolean) { canManageHousehold = value; },
		get members() { return members; },
		set members(value: Array<{ id: string; name: string; email: string; role: string }>) { members = value; },
		get mealDate() { return mealDate; },
		set mealDate(value: string) { mealDate = value; },
		get plannedServings() { return plannedServings; },
		set plannedServings(value: number | null) { plannedServings = value; },
		get cookingMealId() { return cookingMealId; },
		set cookingMealId(value: string) { cookingMealId = value; },
		get leftoverServings() { return leftoverServings; },
		set leftoverServings(value: number | null) { leftoverServings = value; },
		get capabilities() { return capabilities; },
		set capabilities(value: { emailDelivery: boolean; recipeSearch: boolean }) { capabilities = value; },
		get dialogFormEl() { return dialogFormEl; },
		set dialogFormEl(value: HTMLFormElement) { dialogFormEl = value; },
		get authEmailError() { return authEmailError; },
		get authPasswordError() { return authPasswordError; },
		authenticate,
		recover,
		openOnboarding,
		finishOnboarding
	});
`;

const hookedPageSource = injectScriptHook(rawPageSource, pageHookCode);
const pageSsrCompiled = compileServerModule('src/routes/+page.svelte', hookedPageSource, {
	'#lib/components/FormField.svelte': formFieldMod,
	'#lib/components/ToggleButton.svelte': noopComponent,
	'#lib/components/DisclosureButton.svelte': noopComponent,
	'#lib/components/RecipeDetail.svelte': { default: noopComponent },
	'#lib/components/ButlerChat.svelte': { default: noopComponent },
	'#lib/components/RecipeEditor.svelte': { default: noopComponent },
	'#lib/components/SyncStatus.svelte': { default: noopComponent },
	'#lib/components/AIConnection.svelte': aiConnectionSsrMod,
	'#lib/components/VoiceSettings.svelte': voiceSettingsSsrMod,
	'#lib/components/RecipeImport.svelte': {
		default: noopComponent,
		emptyImportSession: importSessionMod.emptyImportSession
	}
});

type PageFormApi = {
	kitchen: AppState;
	user: User | null;
	modal: string;
	authMode: string;
	name: string;
	email: string;
	password: string;
	deletePassword: string;
	error: string;
	formSubmitted: boolean;
	pantryInput: string;
	joinCode: string;
	inviteCode: string;
	canManageHousehold: boolean;
	members: Array<{ id: string; name: string; email: string; role: string }>;
	mealDate: string;
	plannedServings: number | null;
	cookingMealId: string;
	leftoverServings: number | null;
	capabilities: { emailDelivery: boolean; recipeSearch: boolean };
	dialogFormEl: HTMLFormElement;
	readonly authEmailError: string;
	readonly authPasswordError: string;
	authenticate: (event: SubmitEvent) => Promise<void>;
	recover: (event: SubmitEvent) => Promise<void>;
	openOnboarding: () => void;
	finishOnboarding: (event: SubmitEvent) => void;
};

function renderPageModal(setup: (api: PageFormApi) => void): string {
	pageSsrCompiled.sandbox.__onPageFormInit = setup;
	return render(pageSsrCompiled.exports.default, {
		props: { data: { authMode: 'local', loginUrl: null, logoutUrl: null } }
	}).body;
}

test('rendered +page.svelte modals resolve aria-describedby and keep unique IDs across error states', () => {
	const registerInvalidHtml = renderPageModal((api) => {
		api.modal = 'auth';
		api.authMode = 'register';
		api.name = 'A';
		api.email = 'not-an-email';
		api.password = 'short';
		api.formSubmitted = true;
	});
	const registerTags = assertValidRenderedAccessibility(registerInvalidHtml, '+page auth register');
	assert.equal(getTagById(registerTags, 'auth-name')?.attrs['aria-invalid'], 'true');
	assert.equal(getTagById(registerTags, 'auth-email')?.attrs['aria-invalid'], 'true');
	assert.equal(
		getTagById(registerTags, 'auth-password')?.attrs['aria-describedby'],
		'auth-password-help auth-password-error'
	);

	const recoverInvalidHtml = renderPageModal((api) => {
		api.capabilities = { emailDelivery: true, recipeSearch: false };
		api.modal = 'recover';
		api.email = 'chef@localhost';
		api.formSubmitted = true;
	});
	const recoverTags = assertValidRenderedAccessibility(recoverInvalidHtml, '+page recover invalid');
	assert.equal(
		getTagById(recoverTags, 'recover-email')?.attrs['aria-describedby'],
		'recover-email-help recover-email-error'
	);

	const resetErrorHtml = renderPageModal((api) => {
		api.modal = 'reset';
		api.password = 'valid-ten-char-password';
		api.error = 'Reset link expired.';
	});
	const resetTags = assertValidRenderedAccessibility(resetErrorHtml, '+page reset server error');
	assert.equal(
		getTagById(resetTags, 'reset-password')?.attrs['aria-describedby'],
		'reset-password-help recover-form-error'
	);

	const deleteErrorHtml = renderPageModal((api) => {
		api.modal = 'delete';
		api.deletePassword = '';
		api.formSubmitted = true;
		api.error = 'Incorrect password.';
	});
	assertValidRenderedAccessibility(deleteErrorHtml, '+page delete combined inline+server error');

	const pantryInvalidHtml = renderPageModal((api) => {
		api.modal = 'pantry';
		api.pantryInput = '0 g flour';
		api.formSubmitted = true;
	});
	const pantryTags = assertValidRenderedAccessibility(pantryInvalidHtml, '+page pantry invalid');
	assert.equal(
		getTagById(pantryTags, 'pantry-ingredients')?.attrs['aria-describedby'],
		'pantry-ingredients-help pantry-ingredients-error'
	);

	const planInvalidHtml = renderPageModal((api) => {
		api.modal = 'plan';
		api.mealDate = '';
		api.plannedServings = 0;
		api.formSubmitted = true;
	});
	const planTags = assertValidRenderedAccessibility(planInvalidHtml, '+page plan invalid');
	assert.equal(getTagById(planTags, 'plan-date')?.attrs['aria-invalid'], 'true');
	assert.equal(
		getTagById(planTags, 'plan-servings')?.attrs['aria-describedby'],
		'plan-servings-help plan-servings-error'
	);

	const cookInvalidHtml = renderPageModal((api) => {
		const meal = api.kitchen.meals[0];
		api.cookingMealId = meal.id;
		api.leftoverServings = meal.servings + 2;
		api.modal = 'cookMeal';
		api.formSubmitted = true;
	});
	const cookTags = assertValidRenderedAccessibility(cookInvalidHtml, '+page cookMeal invalid');
	assert.equal(
		getTagById(cookTags, 'cook-leftovers')?.attrs['aria-describedby'],
		'cook-leftovers-help cook-leftovers-error'
	);

	const householdHtml = renderPageModal((api) => {
		api.modal = 'household';
		api.canManageHousehold = true;
		api.inviteCode = 'INV-999';
		api.members = [{ id: 'u-1', name: 'Chef', email: 'chef@example.com', role: 'owner' }];
		api.joinCode = '';
		api.formSubmitted = true;
		api.error = 'Invitation has expired.';
	});
	const householdTags = assertValidRenderedAccessibility(householdHtml, '+page household');
	assert.equal(
		getTagById(householdTags, 'household-join-code')?.attrs['aria-describedby'],
		'household-join-code-help household-solo-help household-join-code-error household-form-error'
	);

	const onboardingHtml = renderPageModal((api) => {
		api.kitchen.preferences.allergies = 'peanuts, '.repeat(80);
		api.openOnboarding();
	});
	const onboardingTags = assertValidRenderedAccessibility(onboardingHtml, '+page onboarding');
	const onboardingAllergies = getTagById(onboardingTags, 'onboarding-allergies');
	assert.equal(onboardingAllergies?.attrs.maxlength, '2000');
	assert.equal(onboardingAllergies?.attrs['aria-invalid'], 'false');

	const searchHtml = renderPageModal((api) => {
		api.capabilities = { emailDelivery: false, recipeSearch: false };
		api.modal = 'search';
		api.error = 'Search failed.';
	});
	const searchTags = assertValidRenderedAccessibility(searchHtml, '+page search');
	assert.equal(
		getTagById(searchTags, 'search-query')?.attrs['aria-describedby'],
		'search-query-help search-unavailable-help search-form-error'
	);
});

test('login flow allows non-standard non-empty emails to reach server and links server login errors via aria-describedby', async () => {
	const scriptEnd =
		hookedPageSource.indexOf('</script>', hookedPageSource.indexOf('<script lang="ts">')) +
		'</script>'.length;
	const clientScriptJs = ts.transpileModule(
		compile(hookedPageSource.slice(0, scriptEnd), {
			filename: 'src/routes/+page.svelte',
			generate: 'client'
		}).js.code,
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
	).outputText;

	const authCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
	let focusedInvalidCount = 0;

	const modMap: Record<string, unknown> = {
		svelte,
		'svelte/animate': svelteAnimate,
		'svelte/internal/client': svelteClient,
		'svelte/internal/disclose-version': {},
		'svelte/internal/server': svelteServer,
		'@lucide/svelte': iconProxy,
		'#lib/cover-upload.ts': coverUploadMod,
		'#lib/recipe-cover.ts': coverMod,
		'#lib/focus.ts': { focusTrap: () => ({}) },
		'#lib/form-validation.ts': formValidationMod,
		'#lib/components/FormField.svelte': { default: noopComponent },
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
		'#lib/kitchen-workflows.ts': workflowsMod,
		'#lib/discovery.ts': discoveryMod,
		'#lib/recipe-collection.ts': recipeCollectionMod,
		'#lib/recipe-detail.ts': recipeDetailMod,
		'#lib/recipe-draft.ts': recipeDraftMod,
		'#lib/recipe-scraper.ts': scraperMod,
		'#lib/butler.ts': butlerMod,
		'#lib/butler-chat.ts': butlerChatMod,
		'#lib/status.ts': statusMod,
		'#lib/kitchen-export.ts': kitchenExportMod,
		'#lib/voice-capture.ts': { ...voiceCaptureMod, VoiceCapture: class {} },
		'#lib/voice-config.ts': voiceConfigMod,
		'#lib/ai-connections.ts': aiConnectionsMod,
		'#lib/client-workflows.ts': clientWorkflowsMod,
		'#lib/guest-storage.ts': guestMod,
		'#lib/client-sync.ts': syncMod,
		'#lib/components/RecipeDetail.svelte': { default: noopComponent },
		'#lib/components/ButlerChat.svelte': { default: noopComponent },
		'#lib/components/RecipeEditor.svelte': { default: noopComponent },
		'#lib/components/SyncStatus.svelte': { default: noopComponent },
		'#lib/components/StatusRegion.svelte': { default: noopComponent },
		'#lib/components/AIConnection.svelte': { default: noopComponent },
		'#lib/components/VoiceSettings.svelte': { default: noopComponent },
		'#lib/components/RecipeImport.svelte': {
			default: noopComponent,
			emptyImportSession: importSessionMod.emptyImportSession
		}
	};

	const exports: { default?: any } = {};
	let api!: PageFormApi;
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			throw new Error(`Unexpected module ${id}`);
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
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		localStorage: makeMemoryStorage(),
		window: { location: { assign: () => {}, reload: () => {} } },
		navigator: { onLine: true },
		fetch: async (url: string, init?: RequestInit) => {
			if (url === '/api/auth' && init?.method === 'POST') {
				const parsed = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
				authCalls.push({ url, body: parsed });
				return new Response(JSON.stringify({ error: 'Invalid email or password.' }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				});
			}
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	};
	sandbox.globalThis = sandbox;
	sandbox.__onPageFormInit = (captured: PageFormApi) => {
		api = captured;
	};
	runInNewContext(clientScriptJs, sandbox);

	const dispose = svelteClient.effect_root(() => {
		exports.default(
			{},
			{
				data: { authMode: 'local', loginUrl: null, logoutUrl: null }
			}
		);
	});

	try {
		const fakeForm = {
			querySelector: () => ({
				closest: () => null,
				scrollIntoView: () => {},
				focus: () => {
					focusedInvalidCount += 1;
				}
			})
		} as unknown as HTMLFormElement;
		const submitEvent = { preventDefault: () => {} } as SubmitEvent;

		// 1. Blank login fields fail inline without hitting /api/auth.
		api.modal = 'auth';
		api.authMode = 'login';
		await svelte.tick();
		api.email = '   ';
		api.password = '';
		api.dialogFormEl = fakeForm;
		await api.authenticate(submitEvent);
		assert.equal(authCalls.length, 0);
		assert.equal(api.formSubmitted, true);
		assert.equal(api.authEmailError, 'Enter your email address.');
		assert.equal(api.authPasswordError, 'Enter your password.');
		assert.equal(focusedInvalidCount, 1);

		const blankLoginHtml = renderPageModal((ssr) => {
			ssr.modal = api.modal;
			ssr.authMode = api.authMode;
			ssr.email = api.email;
			ssr.password = api.password;
			ssr.error = api.error;
			ssr.formSubmitted = api.formSubmitted;
		});
		const blankTags = assertValidRenderedAccessibility(blankLoginHtml, 'login blank inline error');
		assert.equal(getTagById(blankTags, 'auth-email')?.attrs['aria-invalid'], 'true');
		assert.equal(
			getTagById(blankTags, 'auth-email')?.attrs['aria-describedby'],
			'auth-email-error'
		);
		assert.equal(getTagById(blankTags, 'auth-password')?.attrs['aria-invalid'], 'true');
		assert.equal(
			getTagById(blankTags, 'auth-password')?.attrs['aria-describedby'],
			'auth-password-help auth-password-error'
		);

		// 2. Non-standard email ('chef@localhost') is NOT blocked client-side on login;
		// server 401 error marks #auth-email and #auth-password invalid and links #auth-form-error.
		api.email = 'chef@localhost';
		api.password = 'wrong-pass';
		await api.authenticate(submitEvent);
		assert.equal(authCalls.length, 1);
		assert.equal(authCalls[0].body.action, 'login');
		assert.equal(authCalls[0].body.email, 'chef@localhost');
		assert.equal(api.formSubmitted, false);
		assert.equal(api.error, 'Invalid email or password.');
		assert.equal(api.modal, 'auth');
		assert.equal(focusedInvalidCount, 2);

		const serverLoginErrorHtml = renderPageModal((ssr) => {
			ssr.modal = api.modal;
			ssr.authMode = api.authMode;
			ssr.email = api.email;
			ssr.password = api.password;
			ssr.error = api.error;
			ssr.formSubmitted = api.formSubmitted;
		});
		const serverErrorTags = assertValidRenderedAccessibility(
			serverLoginErrorHtml,
			'login server error'
		);
		assert.equal(getTagById(serverErrorTags, 'auth-email')?.attrs['aria-invalid'], 'true');
		assert.equal(
			getTagById(serverErrorTags, 'auth-email')?.attrs['aria-describedby'],
			'auth-form-error'
		);
		assert.equal(getTagById(serverErrorTags, 'auth-password')?.attrs['aria-invalid'], 'true');
		assert.equal(
			getTagById(serverErrorTags, 'auth-password')?.attrs['aria-describedby'],
			'auth-password-help auth-form-error'
		);
		assert.equal(getTagById(serverErrorTags, 'auth-form-error')?.attrs.role, 'alert');
		assert.equal(
			findElementTextById(serverLoginErrorHtml, 'auth-form-error'),
			'Invalid email or password.'
		);

		// 3. Onboarding preserves >500-char allergy strings up to the 2,000-char schema limit.
		const longAllergies = 'tree nuts, sesame, shellfish, '.repeat(40).trim();
		assert.ok(longAllergies.length > 500 && longAllergies.length <= 2_000);
		api.kitchen.preferences.allergies = longAllergies;
		api.openOnboarding();
		api.finishOnboarding(submitEvent);
		assert.equal(api.modal, '');
		assert.equal(api.kitchen.preferences.onboardingStatus, 'completed');
		assert.equal(api.kitchen.preferences.allergies, longAllergies);
	} finally {
		dispose();
	}
});
