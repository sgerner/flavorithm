import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compile } from 'svelte/compiler';
import * as svelte from 'svelte';
import * as svelteAnimate from 'svelte/animate';
import ts from 'typescript';
import * as aiConnectionsMod from '../src/lib/ai-connections.ts';
import * as aiContinuationMod from '../src/lib/ai-continuation.ts';
import {
	SCAN_PHOTO_ACCEPT,
	SCAN_PHOTO_MIME_TYPES,
	applyGenerateGuestFilters,
	captureGenerateGuestFilters,
	hasAIConnection,
	isSupportedScanPhotoType,
	resolvePostSetupAction,
	shouldOpenPantryOnScanError,
	transitionButlerOwner,
	type PendingAIContinuation
} from '../src/lib/ai-continuation.ts';
import * as butlerMod from '../src/lib/butler.ts';
import * as butlerChatMod from '../src/lib/butler-chat.ts';
import * as syncMod from '../src/lib/client-sync.ts';
import * as clientWorkflowsMod from '../src/lib/client-workflows.ts';
import * as coverUploadMod from '../src/lib/cover-upload.ts';
import * as dataMod from '../src/lib/data.ts';
import { defaultPreferences } from '../src/lib/data.ts';
import * as discoveryMod from '../src/lib/discovery.ts';
import * as domainMod from '../src/lib/domain.ts';
import * as formValidationMod from '../src/lib/form-validation.ts';
import * as guestMod from '../src/lib/guest-storage.ts';
import * as importSessionMod from '../src/lib/import-session.ts';
import * as kitchenExportMod from '../src/lib/kitchen-export.ts';
import * as workflowsMod from '../src/lib/kitchen-workflows.ts';
import type { PantryDraft } from '../src/lib/kitchen-workflows.ts';
import * as plannerMod from '../src/lib/planner.ts';
import * as recipeCollectionMod from '../src/lib/recipe-collection.ts';
import * as coverMod from '../src/lib/recipe-cover.ts';
import * as recipeDetailMod from '../src/lib/recipe-detail.ts';
import * as recipeDraftMod from '../src/lib/recipe-draft.ts';
import * as recipeSubflowsMod from '../src/lib/recipe-subflows.ts';
import * as scraperMod from '../src/lib/recipe-scraper.ts';
import type { AppState, Recipe, User } from '../src/lib/types.ts';
import * as voiceCaptureMod from '../src/lib/voice-capture.ts';
import type { ResumeDialog } from '../src/lib/voice-capture.ts';
import * as voiceConfigMod from '../src/lib/voice-config.ts';

const userA: User = {
	id: 'user-a',
	householdId: 'house-a',
	name: 'Ada Lovelace',
	email: 'ada@example.test'
};

const userB: User = {
	id: 'user-b',
	householdId: 'house-b',
	name: 'Grace Hopper',
	email: 'grace@example.test'
};

test('hasAIConnection enforces sign-in, model selection, and active key or ChatGPT plan', () => {
	assert.equal(
		hasAIConnection({
			user: null,
			preferences: { provider: 'openai', model: 'gpt-4o-mini' },
			apiKey: 'sk-test'
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'openai', model: 'gpt-4o-mini' },
			apiKey: ''
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'openai', model: '' },
			apiKey: 'sk-test'
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'openai', model: 'gpt-4o-mini' },
			apiKey: 'sk-test'
		}),
		true
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'chatgpt', model: 'gpt-5-codex' },
			apiKey: '',
			activeChatGPTAccount: { connected: true, planEnabled: false }
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'chatgpt', model: 'gpt-5-codex' },
			apiKey: '',
			activeChatGPTAccount: { connected: true, planEnabled: true }
		}),
		true
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'openai', model: '' },
			apiKey: '',
			usingHostAI: true
		}),
		true
	);
	assert.equal(
		hasAIConnection({
			user: null,
			preferences: { provider: 'openai', model: '' },
			apiKey: '',
			usingHostAI: true
		}),
		false
	);
});

test('resolvePostSetupAction chains Settings when AI is unready and resumes all five workflows when ready', () => {
	assert.equal(resolvePostSetupAction(null, false), 'none');
	assert.equal(resolvePostSetupAction(null, true), 'none');

	const continuations: PendingAIContinuation[] = [
		{ kind: 'import' },
		{ kind: 'generate', prompt: 'Spicy tofu stir-fry', guestFilters: { diet: 'Vegan' } },
		{ kind: 'butler', prompt: 'Plan dinners for the week using my pantry.' },
		{ kind: 'scan', returnToPantryModal: true },
		{ kind: 'nutrition', recipeId: 'lemon-herb-chicken', servings: 4 }
	];

	for (const continuation of continuations) {
		assert.equal(resolvePostSetupAction(continuation, false), 'settings');
		assert.equal(resolvePostSetupAction(continuation, true), 'resume');
	}
});

test('scan MIME allowlist matches hidden file input accept attribute and excludes gif', () => {
	assert.deepEqual(SCAN_PHOTO_MIME_TYPES, ['image/jpeg', 'image/png', 'image/webp']);
	assert.equal(SCAN_PHOTO_ACCEPT, 'image/jpeg,image/png,image/webp');
	assert.equal(isSupportedScanPhotoType('image/jpeg'), true);
	assert.equal(isSupportedScanPhotoType('IMAGE/PNG'), true);
	assert.equal(isSupportedScanPhotoType('image/webp'), true);
	assert.equal(isSupportedScanPhotoType('image/gif'), false);
	assert.equal(isSupportedScanPhotoType(''), false);
	assert.equal(isSupportedScanPhotoType('application/pdf'), false);
});

test('shouldOpenPantryOnScanError guards unrelated modals, overlays, aborts, and non-pantry pages', () => {
	assert.equal(
		shouldOpenPantryOnScanError({
			aborted: true,
			modal: 'pantry',
			page: 'pantry',
			hasOverlay: false,
			fromContinuation: true
		}),
		false
	);
	assert.equal(
		shouldOpenPantryOnScanError({
			aborted: false,
			modal: 'pantry',
			page: 'discover',
			hasOverlay: false,
			fromContinuation: false
		}),
		true
	);
	assert.equal(
		shouldOpenPantryOnScanError({
			aborted: false,
			modal: 'settings',
			page: 'pantry',
			hasOverlay: false,
			fromContinuation: true
		}),
		false
	);
	assert.equal(
		shouldOpenPantryOnScanError({
			aborted: false,
			modal: '',
			page: 'pantry',
			hasOverlay: true,
			fromContinuation: true
		}),
		false
	);
	assert.equal(
		shouldOpenPantryOnScanError({
			aborted: false,
			modal: '',
			page: 'pantry',
			hasOverlay: false,
			fromContinuation: false
		}),
		true
	);
	assert.equal(
		shouldOpenPantryOnScanError({
			aborted: false,
			modal: '',
			page: 'discover',
			hasOverlay: false,
			fromContinuation: false
		}),
		false
	);
	assert.equal(
		shouldOpenPantryOnScanError({
			aborted: false,
			modal: '',
			page: 'discover',
			hasOverlay: false,
			fromContinuation: true
		}),
		true
	);
});

test('guest dietary filter overrides in Generate recipes preserve customized fields without clobbering saved account preferences', () => {
	assert.equal(captureGenerateGuestFilters(defaultPreferences, defaultPreferences), undefined);

	const guestEdited = {
		maxTime: 30,
		diet: 'Vegan',
		allergies: defaultPreferences.allergies
	};
	const captured = captureGenerateGuestFilters(guestEdited, defaultPreferences);
	assert.deepEqual(captured, { maxTime: 30, diet: 'Vegan' });

	const savedAccountPreferences = {
		maxTime: 60,
		diet: 'none',
		allergies: 'shellfish, peanuts'
	};
	applyGenerateGuestFilters(savedAccountPreferences, captured);
	assert.deepEqual(savedAccountPreferences, {
		maxTime: 30,
		diet: 'Vegan',
		allergies: 'shellfish, peanuts'
	});
});

test('transitionButlerOwner preserves only pending prompt from guest to signed-in owner and clears transcripts', () => {
	const fromDraft = transitionButlerOwner('guest:', 'user-a:house-a', {
		messages: [{ id: 1, role: 'user', content: 'Old guest turn' }],
		recipeDrafts: [{ id: 'draft-1' }],
		draft: 'What can I cook with chickpeas tonight?',
		error: 'Sign in first',
		failedPrompt: 'Fallback prompt',
		applying: '1:a'
	});
	assert.deepEqual(fromDraft, {
		messages: [],
		recipeDrafts: [],
		draft: 'What can I cook with chickpeas tonight?',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const fromFailedPrompt = transitionButlerOwner('guest:', 'user-a:house-a', {
		messages: [{ id: 1, role: 'user', content: 'Plan dinners for the week.' }],
		recipeDrafts: [{ id: 'draft-1' }],
		draft: '',
		error: 'Sign in and connect a model in Settings to speak with Basil.',
		failedPrompt: 'Plan dinners for the week.',
		applying: ''
	});
	assert.deepEqual(fromFailedPrompt, {
		messages: [],
		recipeDrafts: [],
		draft: 'Plan dinners for the week.',
		error: '',
		failedPrompt: '',
		applying: ''
	});
});

test('transitionButlerOwner wipes messages, draft, failedPrompt, and recipeDrafts when switching between signed-in accounts or signing out', () => {
	const populated = {
		messages: [
			{ id: 1, role: 'user', content: 'Private recipe request' },
			{ id: 2, role: 'assistant', content: 'Private reply', actions: [{ id: 'act-1' }] }
		],
		recipeDrafts: [{ id: 'secret-recipe' }],
		draft: 'Unfinished private prompt',
		error: 'Temporary error',
		failedPrompt: 'Failed private prompt',
		applying: '2:act-1'
	};

	const switchedAccount = transitionButlerOwner('user-a:house-a', 'user-b:house-b', populated);
	assert.deepEqual(switchedAccount, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const switchedHousehold = transitionButlerOwner('user-a:house-a', 'user-a:house-b', populated);
	assert.deepEqual(switchedHousehold, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const signedOut = transitionButlerOwner('user-a:house-a', 'guest:', populated);
	assert.deepEqual(signedOut, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const nextUserAfterSignOut = transitionButlerOwner('guest:', 'user-b:house-b', signedOut);
	assert.deepEqual(nextUserAfterSignOut, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});
});

// ---------------------------------------------------------------------------
// Reactive +page.svelte VM harness for integration coverage of page workflows
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);
const svelteClient = nodeRequire('svelte/internal/client') as {
	effect_root: (fn: () => void) => () => void;
};
const svelteServer = nodeRequire('svelte/internal/server') as Record<string, unknown>;

const rawPageSource = readFileSync('src/routes/+page.svelte', 'utf8');

function injectContinuationHook(svelteSource: string): string {
	const instanceStart = svelteSource.indexOf('<script lang="ts">');
	assert.notEqual(instanceStart, -1, 'expected instance <script lang="ts"> in +page.svelte');
	const instanceEnd = svelteSource.indexOf('</script>', instanceStart);
	assert.notEqual(instanceEnd, -1, 'expected closing </script> for instance script');
	const hook = `
	(globalThis as any).__onPageContinuationInit?.({
		get kitchen() { return kitchen; },
		set kitchen(value: AppState) { kitchen = value; },
		get user() { return user; },
		set user(value: User | null) { user = value; },
		get page() { return page; },
		set page(value: string) { page = value; },
		get modal() { return modal; },
		set modal(value: string) { modal = value; },
		get mobileNav() { return mobileNav; },
		set mobileNav(value: boolean) { mobileNav = value; },
		get prompt() { return prompt; },
		set prompt(value: string) { prompt = value; },
		get apiKey() { return apiKey; },
		set apiKey(value: string) { apiKey = value; },
		get pendingAIContinuation() { return pendingAIContinuation; },
		set pendingAIContinuation(value: PendingAIContinuation | null) { pendingAIContinuation = value; },
		get stagedScanFile() { return stagedScanFile; },
		set stagedScanFile(value: File | null) { stagedScanFile = value; },
		get pantryInput() { return pantryInput; },
		set pantryInput(value: string) { pantryInput = value; },
		get pantryDraft() { return pantryDraft; },
		set pantryDraft(value: PantryDraft | null) { pantryDraft = value; },
		get importSession() { return importSession; },
		set importSession(value: any) { importSession = value; },
		get resumeDialog() { return resumeDialog; },
		set resumeDialog(value: ResumeDialog) { resumeDialog = value; },
		get selected() { return selected; },
		set selected(value: Recipe | null) { selectedId = value?.id ?? null; },
		get selectedMealServings() { return selectedMealServings; },
		set selectedMealServings(value: number | undefined) { selectedMealServings = value; },
		get selectedDetailTab() { return selectedDetailTab; },
		set selectedDetailTab(value: 'recipe' | 'nutrition') { selectedDetailTab = value; },
		get editingRecipe() { return editingRecipe; },
		set editingRecipe(value: Recipe | null) { editingRecipe = value; },
		get editingRecipeMode() { return editingRecipeMode; },
		set editingRecipeMode(value: 'create' | 'edit') { editingRecipeMode = value; },
		get butlerOpen() { return butlerOpen; },
		set butlerOpen(value: boolean) { butlerOpen = value; },
		setButlerChat(value: any) { butlerChat = value; },
		setImageInput(value: any) { imageInput = value; },
		get runtimeAuthMode() { return runtimeAuthMode; },
		set runtimeAuthMode(value: 'local' | 'oidc' | 'proxy' | 'invalid' | null) { runtimeAuthMode = value; },
		get runtimeLogoutUrl() { return runtimeLogoutUrl; },
		set runtimeLogoutUrl(value: string | null) { runtimeLogoutUrl = value; },
		get authMetadataLoaded() { return authMetadataLoaded; },
		set authMetadataLoaded(value: boolean) { authMetadataLoaded = value; },
		get toastMessage() { return toast; },
		isAIReady,
		restoreAIContinuation,
		dismissAIContinuation,
		closeDialog,
		generate,
		askButler,
		captureImport,
		refreshNutrition,
		scan,
		scanPantryPhoto,
		cancelScan,
		addIngredients,
		logout,
		set deletePassword(value: string) { deletePassword = value; },
		deleteAccount,
		clearManagedIdentity,
		refreshAuth,
		handleWindowKeydown
	});
`;
	return svelteSource.slice(0, instanceEnd) + hook + svelteSource.slice(instanceEnd);
}

const hookedPageSource = injectContinuationHook(rawPageSource);
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

type PageContinuationApi = {
	kitchen: AppState;
	user: User | null;
	page: string;
	modal: string;
	mobileNav: boolean;
	prompt: string;
	apiKey: string;
	pendingAIContinuation: PendingAIContinuation | null;
	stagedScanFile: File | null;
	pantryInput: string;
	pantryDraft: PantryDraft | null;
	importSession: {
		url: string;
		text: string;
		photo: string;
		photoName: string;
		draft: Recipe | null;
		baseline: Recipe | null;
		assumptions: string[];
	};
	resumeDialog: ResumeDialog;
	selected: Recipe | null;
	selectedMealServings: number | undefined;
	selectedDetailTab: 'recipe' | 'nutrition';
	editingRecipe: Recipe | null;
	editingRecipeMode: 'create' | 'edit';
	butlerOpen: boolean;
	setButlerChat: (value: {
		close?: () => Promise<void>;
		reopen?: (prompt?: string) => Promise<void>;
	}) => void;
	setImageInput: (value: { value: string; files?: File[]; click?: () => void }) => void;
	runtimeAuthMode: 'local' | 'oidc' | 'proxy' | 'invalid' | null;
	runtimeLogoutUrl: string | null;
	authMetadataLoaded: boolean;
	readonly toastMessage: string;
	isAIReady: () => boolean;
	restoreAIContinuation: () => void;
	dismissAIContinuation: () => void;
	closeDialog: () => void;
	generate: () => Promise<void>;
	askButler: (
		message: string,
		history: { role: 'user' | 'assistant'; content: string }[],
		signal?: AbortSignal,
		recipeDrafts?: Recipe[]
	) => Promise<{ reply: string; commands: unknown[] } | null>;
	captureImport: (
		input: { url?: string; prompt: string; image?: string },
		signal: AbortSignal
	) => Promise<unknown>;
	refreshNutrition: () => Promise<void>;
	scan: (event: Event) => Promise<void>;
	scanPantryPhoto: (file: File, fromContinuation?: boolean) => Promise<void>;
	cancelScan: (silent?: boolean) => void;
	addIngredients: (event?: SubmitEvent) => Promise<void>;
	logout: () => Promise<void>;
	deletePassword: string;
	deleteAccount: (event: SubmitEvent) => Promise<void>;
	clearManagedIdentity: () => void;
	refreshAuth: () => Promise<unknown>;
	handleWindowKeydown: (event: KeyboardEvent) => void;
};

const noopComponent = () => {};
const iconProxy = new Proxy({}, { get: () => noopComponent });

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

function makeRecipe(id: string, title = `Recipe ${id}`): Recipe {
	return {
		id,
		title,
		description: `Description for ${title}`,
		image: `/covers/${id}.jpg`,
		time: 25,
		servings: 4,
		difficulty: 'Easy',
		cuisine: 'Mediterranean',
		tags: ['Weeknight'],
		ingredients: [{ name: 'olive oil', quantity: 1, unit: 'tbsp' }],
		steps: ['Cook and serve.'],
		nutrition: {
			calories: 400,
			fat: 14,
			saturatedFat: 2,
			sodium: 320,
			carbs: 42,
			fiber: 6,
			sugar: 4,
			protein: 18
		},
		saved: true
	};
}

function createReactivePage(options?: {
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	preparePhotoImpl?: (file: File, opts?: { signal?: AbortSignal }) => Promise<string>;
}) {
	const preparePhoto =
		options?.preparePhotoImpl ??
		(async (_file: File, opts?: { signal?: AbortSignal }) => {
			opts?.signal?.throwIfAborted();
			return 'data:image/jpeg;base64,dGVzdA==';
		});
	const modMap: Record<string, unknown> = {
		svelte,
		'svelte/animate': svelteAnimate,
		'svelte/internal/client': svelteClient,
		'svelte/internal/disclose-version': {},
		'svelte/internal/server': svelteServer,
		'@lucide/svelte': iconProxy,
		'#lib/cover-upload.ts': {
			...coverUploadMod,
			prepareAIPhoto: preparePhoto
		},
		'#lib/recipe-cover.ts': coverMod,
		'#lib/focus.ts': { focusTrap: () => ({}), activeFocusedElement: () => null },
		'#lib/form-validation.ts': formValidationMod,
		'#lib/motion.ts': {
			backdropMotion: () => ({}),
			dialogMotion: () => ({}),
			revealMotion: () => ({}),
			fadeMotion: () => ({}),
			motionDuration: () => 0,
			prefersReducedMotion: () => true
		},
		'#lib/ai-continuation.ts': aiContinuationMod,
		'#lib/planner.ts': plannerMod,
		'#lib/data.ts': dataMod,
		'#lib/domain.ts': domainMod,
		'#lib/import-session.ts': importSessionMod,
		'#lib/kitchen-workflows.ts': workflowsMod,
		'#lib/discovery.ts': discoveryMod,
		'#lib/recipe-collection.ts': recipeCollectionMod,
		'#lib/recipe-detail.ts': recipeDetailMod,
		'#lib/recipe-draft.ts': recipeDraftMod,
		'#lib/recipe-subflows.ts': recipeSubflowsMod,
		'#lib/butler.ts': butlerMod,
		'#lib/butler-chat.ts': butlerChatMod,
		'#lib/voice-capture.ts': { ...voiceCaptureMod, VoiceCapture: class {} },
		'#lib/voice-config.ts': voiceConfigMod,
		'#lib/ai-connections.ts': aiConnectionsMod,
		'#lib/client-workflows.ts': clientWorkflowsMod,
		'#lib/guest-storage.ts': guestMod,
		'#lib/kitchen-export.ts': kitchenExportMod,
		'#lib/client-sync.ts': syncMod,
		'#lib/recipe-scraper.ts': scraperMod,
		'#lib/components/RecipeDetail.svelte': { default: noopComponent },
		'#lib/components/FormField.svelte': { default: noopComponent },
		'#lib/components/ToggleButton.svelte': { default: noopComponent },
		'#lib/components/ButlerChat.svelte': { default: noopComponent },
		'#lib/components/RecipeEditor.svelte': { default: noopComponent },
		'#lib/components/SyncStatus.svelte': { default: noopComponent },
		'#lib/components/AIConnection.svelte': { default: noopComponent },
		'#lib/components/VoiceSettings.svelte': { default: noopComponent },
		'#lib/components/RecipeImport.svelte': {
			default: noopComponent,
			emptyImportSession: importSessionMod.emptyImportSession
		}
	};

	const exports: { default?: any } = {};
	let api!: PageContinuationApi;
	const assignedUrls: string[] = [];
	const reopenedPrompts: string[] = [];
	let butlerCloseCalls = 0;
	const imageInputStub = { value: '', files: [] as File[] };
	const storage = makeMemoryStorage();
	const defaultFetch = async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith('/api/auth')) {
			return new Response(
				JSON.stringify({
					user: api?.user ?? null,
					authMode: 'local',
					loginUrl: null,
					logoutUrl: null,
					capabilities: { emailDelivery: false, recipeSearch: false }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}
		if (url.endsWith('/api/state')) {
			return new Response(JSON.stringify({ state: api?.kitchen ?? null }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		return new Response(
			JSON.stringify({
				ok: true,
				providers: [],
				accounts: [],
				configured: false,
				mode: 'unavailable'
			}),
			{
				status: 200,
				headers: { 'content-type': 'application/json' }
			}
		);
	};

	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			if (id.startsWith('#lib/components/') && id.endsWith('.svelte')) {
				return { __esModule: true, default: noopComponent };
			}
			throw new Error(`Unexpected page dependency ${id}`);
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
		DOMException,
		AbortController,
		CSS: { escape: (value: string) => value },
		File,
		Blob,
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
		localStorage: storage,
		navigator: { onLine: true },
		document: {
			getElementById: () => null,
			querySelector: () => null
		},
		window: {
			location: {
				assign: (url: string) => assignedUrls.push(url),
				reload: () => {}
			},
			scrollTo: () => {}
		},
		fetch: options?.fetchImpl ?? defaultFetch
	};
	sandbox.globalThis = sandbox;
	sandbox.__onPageContinuationInit = (instance: PageContinuationApi) => {
		api = instance;
	};
	runInNewContext(clientScriptJs, sandbox);
	const dispose = svelteClient.effect_root(() => {
		exports.default(null, { data: { authMode: 'local', loginUrl: null, logoutUrl: null } });
	});
	api.setImageInput(imageInputStub);
	api.setButlerChat({
		close: async () => {
			butlerCloseCalls++;
			api.butlerOpen = false;
		},
		reopen: async (fallbackPrompt = '') => {
			reopenedPrompts.push(fallbackPrompt);
			api.butlerOpen = true;
		}
	});
	return {
		api,
		assignedUrls,
		reopenedPrompts,
		getButlerCloseCalls: () => butlerCloseCalls,
		imageInputStub,
		storage,
		dispose
	};
}

test('+page.svelte file input binds accept to SCAN_PHOTO_ACCEPT', () => {
	assert.match(rawPageSource, /type="file"\s+accept=\{SCAN_PHOTO_ACCEPT\}/);
});

test('restoreAIContinuation and closeDialog resume all five workflows when AI is ready', async () => {
	let aiCalls = 0;
	const harness = createReactivePage({
		fetchImpl: async (input) => {
			const url = String(input);
			if (url.endsWith('/api/ai')) {
				aiCalls++;
				return new Response(
					JSON.stringify({
						ingredients: [
							{ name: 'Roma tomatoes', quantity: 4, unit: 'whole', category: 'Produce' }
						]
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			return new Response(
				JSON.stringify({
					ok: true,
					providers: [],
					accounts: [],
					configured: false,
					mode: 'unavailable'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}
	});

	try {
		const { api, reopenedPrompts } = harness;
		const recipe = makeRecipe('herb-pasta', 'Herb Pasta');
		api.kitchen.recipes = [recipe];
		api.user = { ...userA };
		api.kitchen.preferences.provider = 'openai';
		api.kitchen.preferences.model = 'gpt-4o-mini';
		api.apiKey = 'sk-ready-key';
		assert.equal(api.isAIReady(), true);

		// 1. import continuation
		api.importSession = {
			...api.importSession,
			url: 'https://example.test/pasta',
			text: '200g pasta'
		};
		api.pendingAIContinuation = { kind: 'import' };
		api.modal = 'settings';
		api.closeDialog();
		assert.equal(api.modal, 'import');
		assert.equal(api.pendingAIContinuation, null);
		assert.equal(api.importSession.url, 'https://example.test/pasta');

		// 2. generate continuation
		api.prompt = '';
		api.pendingAIContinuation = { kind: 'generate', prompt: 'Smoky lentil tacos' };
		api.modal = 'settings';
		api.closeDialog();
		assert.equal(api.modal, 'generate');
		assert.equal(api.prompt, 'Smoky lentil tacos');
		assert.equal(api.pendingAIContinuation, null);

		// 3. butler continuation
		api.butlerOpen = false;
		api.pendingAIContinuation = { kind: 'butler', prompt: 'Plan three quick dinners.' };
		api.modal = 'settings';
		api.closeDialog();
		await Promise.resolve();
		assert.equal(api.modal, '');
		assert.equal(api.butlerOpen, true);
		assert.deepEqual(reopenedPrompts, ['Plan three quick dinners.']);
		assert.equal(api.pendingAIContinuation, null);
		api.butlerOpen = false;

		// 4. scan continuation auto-runs vision recognition and populates pantryInput
		const photo = new File([new Uint8Array([1, 2, 3])], 'farmers-market.jpg', {
			type: 'image/jpeg'
		});
		api.stagedScanFile = photo;
		api.pantryInput = '';
		api.pendingAIContinuation = { kind: 'scan', returnToPantryModal: false };
		api.modal = 'settings';
		api.closeDialog();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(aiCalls, 1);
		assert.equal(api.modal, 'pantry');
		assert.equal(api.stagedScanFile, null);
		assert.equal(api.pendingAIContinuation, null);
		assert.match(api.pantryInput, /4 each Roma tomatoes \[Produce\]/);

		// 5. nutrition continuation restores RecipeDetail on Nutrition facts tab
		api.selected = null;
		api.selectedMealServings = undefined;
		api.selectedDetailTab = 'recipe';
		api.pendingAIContinuation = { kind: 'nutrition', recipeId: 'herb-pasta', servings: 6 };
		api.modal = 'settings';
		api.closeDialog();
		assert.equal(api.modal, '');
		assert.equal((api.selected as Recipe | null)?.id, 'herb-pasta');
		assert.equal(api.selectedMealServings, 6);
		assert.equal(api.selectedDetailTab, 'nutrition');
		assert.equal(api.pendingAIContinuation, null);

		// Missing recipe ID falls back safely
		api.pendingAIContinuation = { kind: 'nutrition', recipeId: 'deleted-recipe', servings: 3 };
		api.modal = 'settings';
		api.closeDialog();
		assert.equal(api.modal, '');
		assert.equal(api.selected, null);
		assert.equal(api.selectedMealServings, undefined);
		assert.equal(api.selectedDetailTab, 'recipe');
	} finally {
		harness.dispose();
	}
});

test('closeDialog guards pending continuations when Settings or Auth closes without AI readiness', async () => {
	const harness = createReactivePage();
	try {
		const { api, reopenedPrompts } = harness;
		const recipe = makeRecipe('lemon-salmon', 'Lemon Salmon');
		api.kitchen.recipes = [recipe];
		api.user = { ...userA };
		api.kitchen.preferences.provider = 'openai';
		api.kitchen.preferences.model = 'gpt-4o-mini';
		api.apiKey = '';
		assert.equal(api.isAIReady(), false);

		// generate: preserves prompt in state without trapping user back in Generate modal
		api.prompt = 'Crisp chickpea flatbread';
		api.modal = 'generate';
		await api.generate();
		assert.equal(api.modal, 'settings');
		assert.deepEqual(JSON.parse(JSON.stringify(api.pendingAIContinuation)), {
			kind: 'generate',
			prompt: 'Crisp chickpea flatbread'
		});
		api.closeDialog();
		assert.equal(api.modal, '');
		assert.equal(api.prompt, 'Crisp chickpea flatbread');
		assert.equal(api.pendingAIContinuation, null);

		// butler: closes Settings cleanly without reopening AI-only Basil drawer
		api.butlerOpen = true;
		const butlerResult = await api.askButler('Suggest a soup.', []);
		assert.equal(butlerResult, null);
		assert.equal(api.modal, 'settings');
		assert.equal(api.butlerOpen, false);
		api.closeDialog();
		assert.equal(api.modal, '');
		assert.equal(api.butlerOpen, false);
		assert.deepEqual(reopenedPrompts, []);
		assert.equal(api.pendingAIContinuation, null);

		// scan initiated outside pantry modal: clears stagedScanFile and closes to ''
		const inlinePhoto = new File([new Uint8Array([9, 8, 7])], 'counter.png', { type: 'image/png' });
		api.page = 'pantry';
		api.modal = '';
		await api.scanPantryPhoto(inlinePhoto);
		assert.equal(api.modal, 'settings');
		assert.equal(api.stagedScanFile, inlinePhoto);
		api.closeDialog();
		assert.equal(api.modal, '');
		assert.equal(api.stagedScanFile, null);
		assert.equal(api.pendingAIContinuation, null);

		// scan initiated from inside Add ingredients modal: returns to pantry modal with staged file intact
		const dialogPhoto = new File([new Uint8Array([4, 5, 6])], 'fridge.webp', {
			type: 'image/webp'
		});
		api.modal = 'pantry';
		await api.scanPantryPhoto(dialogPhoto);
		assert.equal(api.modal, 'settings');
		api.closeDialog();
		assert.equal(api.modal, 'pantry');
		assert.equal(api.stagedScanFile, dialogPhoto);
		assert.equal(api.pendingAIContinuation, null);
		api.stagedScanFile = null;

		// import: returns to import modal so manual draft / URL scraper work stays accessible
		api.modal = 'import';
		api.importSession = { ...api.importSession, text: '1 cup flour' };
		const captureResult = await api.captureImport(
			{ prompt: '1 cup flour' },
			new AbortController().signal
		);
		assert.equal(captureResult, null);
		assert.equal(api.modal, 'settings');
		api.closeDialog();
		assert.equal(api.modal, 'import');
		assert.equal(api.importSession.text, '1 cup flour');
		assert.equal(api.pendingAIContinuation, null);

		// nutrition: returns to RecipeDetail on Nutrition facts tab
		api.modal = '';
		api.selected = recipe;
		api.selectedMealServings = 3;
		api.selectedDetailTab = 'recipe';
		await api.refreshNutrition();
		assert.equal(api.modal, 'settings');
		api.closeDialog();
		assert.equal(api.modal, '');
		assert.equal(api.selected?.id, 'lemon-salmon');
		assert.equal(api.selectedMealServings, 3);
		assert.equal(api.selectedDetailTab, 'nutrition');
		assert.equal(api.pendingAIContinuation, null);
	} finally {
		harness.dispose();
	}
});

test('scan staging validates MIME/size, resets file inputs immediately, and guards catch modal switching', async () => {
	let rejectVisionWith: Error | null = null;
	const harness = createReactivePage({
		fetchImpl: async (input) => {
			const url = String(input);
			if (url.endsWith('/api/ai')) {
				if (rejectVisionWith) {
					return new Response(JSON.stringify({ error: rejectVisionWith.message }), {
						status: 502,
						headers: { 'content-type': 'application/json' }
					});
				}
				return new Response(JSON.stringify({ ingredients: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(
				JSON.stringify({
					ok: true,
					providers: [],
					accounts: [],
					configured: false,
					mode: 'unavailable'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}
	});

	try {
		const { api, imageInputStub } = harness;

		// 1. Unsupported GIF is rejected before needAI(), clears both input values immediately, and does not stage
		api.user = null;
		api.modal = '';
		const gifFile = new File([new Uint8Array([71, 73, 70])], 'anim.gif', { type: 'image/gif' });
		const eventInput = { value: 'C:\\fakepath\\anim.gif', files: [gifFile] };
		imageInputStub.value = 'C:\\fakepath\\anim.gif';
		await api.scan({ currentTarget: eventInput, target: eventInput } as unknown as Event);
		assert.equal(eventInput.value, '');
		assert.equal(imageInputStub.value, '');
		assert.equal(api.stagedScanFile, null);
		assert.equal(api.modal, '');
		assert.equal(api.toastMessage, 'Choose a JPG, PNG, or WebP photo.');

		// 2. Oversized > 20 MB photo is rejected before needAI() and clears input values immediately
		const hugePhoto = new File([new Uint8Array(1)], 'huge.jpg', { type: 'image/jpeg' });
		Object.defineProperty(hugePhoto, 'size', {
			value: coverUploadMod.MAX_AI_PHOTO_INPUT_BYTES + 1
		});
		eventInput.value = 'C:\\fakepath\\huge.jpg';
		eventInput.files = [hugePhoto];
		imageInputStub.value = 'C:\\fakepath\\huge.jpg';
		await api.scan({ currentTarget: eventInput, target: eventInput } as unknown as Event);
		assert.equal(eventInput.value, '');
		assert.equal(imageInputStub.value, '');
		assert.equal(api.stagedScanFile, null);
		assert.equal(api.modal, '');
		assert.equal(api.toastMessage, 'Choose a photo under 20 MB.');

		// 3. Valid photo when guest stages file, clears input immediately, and records scan continuation
		const validPhoto = new File([new Uint8Array([1, 2, 3])], 'groceries.png', {
			type: 'image/png'
		});
		eventInput.value = 'C:\\fakepath\\groceries.png';
		eventInput.files = [validPhoto];
		imageInputStub.value = 'C:\\fakepath\\groceries.png';
		await api.scan({ currentTarget: eventInput, target: eventInput } as unknown as Event);
		assert.equal(eventInput.value, '');
		assert.equal(imageInputStub.value, '');
		assert.equal(api.stagedScanFile, validPhoto);
		assert.equal(api.modal, 'auth');
		assert.deepEqual(JSON.parse(JSON.stringify(api.pendingAIContinuation)), {
			kind: 'scan',
			returnToPantryModal: false
		});

		// cancelScan clears stagedScanFile
		api.cancelScan(true);
		assert.equal(api.stagedScanFile, null);
		api.pendingAIContinuation = null;

		// 4. Error while an unrelated modal (e.g. 'generate') opened mid-scan does NOT pull user into 'pantry'
		api.user = { ...userA };
		api.kitchen.preferences.provider = 'openai';
		api.kitchen.preferences.model = 'gpt-4o-mini';
		api.apiKey = 'sk-ready';
		api.page = 'pantry';
		api.modal = '';
		rejectVisionWith = new Error('Upstream vision timeout.');
		let unblockScan!: () => void;
		const gate = new Promise<void>((resolve) => {
			unblockScan = resolve;
		});

		const gatedHarness = createReactivePage({
			fetchImpl: async (input) => {
				if (String(input).endsWith('/api/ai')) {
					await gate;
					return new Response(JSON.stringify({ error: 'Vision gateway failed.' }), {
						status: 502,
						headers: { 'content-type': 'application/json' }
					});
				}
				return new Response(
					JSON.stringify({
						ok: true,
						providers: [],
						accounts: [],
						configured: false,
						mode: 'unavailable'
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
		});
		try {
			const g = gatedHarness.api;
			g.user = { ...userA };
			g.kitchen.preferences.provider = 'openai';
			g.kitchen.preferences.model = 'gpt-4o-mini';
			g.apiKey = 'sk-ready';
			g.page = 'pantry';
			g.modal = '';

			const scanTask = g.scanPantryPhoto(validPhoto);
			// User opens unrelated modal while scan is in flight
			g.modal = 'generate';
			unblockScan();
			await scanTask;
			assert.equal(g.modal, 'generate');
			assert.equal(g.toastMessage, 'Vision gateway failed.');
		} finally {
			gatedHarness.dispose();
		}

		// 5. Error when user navigated away to Discover without continuation does NOT open 'pantry'
		api.page = 'discover';
		api.modal = '';
		await api.scanPantryPhoto(validPhoto, false);
		assert.equal(api.modal, '');
		assert.equal(api.toastMessage, 'Upstream vision timeout.');

		// 6. Error when current surface IS pantry opens 'pantry' so staged photo retry bar is shown
		api.page = 'pantry';
		api.modal = '';
		await api.scanPantryPhoto(validPhoto, false);
		assert.equal(api.modal, 'pantry');
		assert.equal(api.stagedScanFile, validPhoto);

		// Adding manual ingredients clears stagedScanFile
		api.pantryInput = '2 lemons';
		await api.addIngredients();
		assert.equal(api.stagedScanFile, null);
		assert.equal(api.modal, '');
	} finally {
		harness.dispose();
	}
});

test('logout, deleteAccount, clearManagedIdentity, and refreshAuth identity switches wipe pending AI state and staged scans', async () => {
	let currentAuthUser: User | null = { ...userA };
	let logoutCalled = 0;
	let deleteCalled = 0;

	const harness = createReactivePage({
		fetchImpl: async (input, init) => {
			const url = String(input);
			if (url.endsWith('/api/auth') && (!init?.method || init.method === 'GET')) {
				return new Response(
					JSON.stringify({
						user: currentAuthUser,
						authMode: 'local',
						loginUrl: null,
						logoutUrl: null,
						capabilities: { emailDelivery: false, recipeSearch: false }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			if (url.endsWith('/api/auth') && init?.method === 'POST') {
				const body = JSON.parse(String(init.body ?? '{}'));
				if (body.action === 'logout') logoutCalled++;
				if (body.action === 'deleteAccount') deleteCalled++;
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			if (url.endsWith('/api/state')) {
				return new Response(JSON.stringify({ state: null }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(
				JSON.stringify({
					ok: true,
					providers: [],
					accounts: [],
					configured: false,
					mode: 'unavailable'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}
	});

	function seedSensitiveSessionState(api: PageContinuationApi, imageInputStub: { value: string }) {
		const recipe = makeRecipe('private-stew', 'Private Stew');
		api.kitchen.recipes = [recipe];
		api.apiKey = 'sk-private-session';
		api.pendingAIContinuation = { kind: 'generate', prompt: 'Secret family recipe' };
		api.stagedScanFile = new File([new Uint8Array([1, 2])], 'private-receipt.jpg', {
			type: 'image/jpeg'
		});
		imageInputStub.value = 'C:\\fakepath\\private-receipt.jpg';
		api.selected = recipe;
		api.selectedMealServings = 5;
		api.selectedDetailTab = 'nutrition';
		api.editingRecipe = recipe;
		api.editingRecipeMode = 'create';
		api.pantryInput = '3 shallots';
		api.importSession = {
			...api.importSession,
			url: 'https://private.example/recipe',
			text: 'Private notes'
		};
		api.resumeDialog = 'import';
	}

	function assertClearedSessionState(api: PageContinuationApi, imageInputStub: { value: string }) {
		assert.equal(api.apiKey, '');
		assert.equal(api.pendingAIContinuation, null);
		assert.equal(api.stagedScanFile, null);
		assert.equal(imageInputStub.value, '');
		assert.equal(api.selected, null);
		assert.equal(api.selectedMealServings, undefined);
		assert.equal(api.selectedDetailTab, 'recipe');
		assert.equal(api.editingRecipe, null);
		assert.equal(api.editingRecipeMode, 'edit');
		assert.equal(api.pantryInput, '');
		assert.equal(api.importSession.url, '');
		assert.equal(api.importSession.text, '');
		assert.equal(api.resumeDialog, '');
	}

	try {
		const { api, imageInputStub, assignedUrls } = harness;

		// 1. Local logout()
		api.user = { ...userA };
		seedSensitiveSessionState(api, imageInputStub);
		await api.logout();
		assert.equal(logoutCalled, 1);
		assert.equal(api.user, null);
		assertClearedSessionState(api, imageInputStub);

		// 2. Managed logout() -> clearManagedIdentity()
		api.runtimeAuthMode = 'oidc';
		api.runtimeLogoutUrl = 'https://idp.example.test/logout';
		api.authMetadataLoaded = true;
		api.user = { ...userA };
		seedSensitiveSessionState(api, imageInputStub);
		await api.logout();
		assert.equal(api.user, null);
		assert.deepEqual(assignedUrls, ['https://idp.example.test/logout']);
		assertClearedSessionState(api, imageInputStub);
		api.runtimeAuthMode = 'local';
		api.runtimeLogoutUrl = null;

		// 3. deleteAccount()
		api.user = { ...userA };
		seedSensitiveSessionState(api, imageInputStub);
		api.deletePassword = 'TestablePassword123!';
		await api.deleteAccount({ preventDefault: () => {} } as unknown as SubmitEvent);
		assert.equal(deleteCalled, 1);
		assert.equal(api.user, null);
		assertClearedSessionState(api, imageInputStub);

		// 4. refreshAuth() identity switch: userA -> userB
		api.user = { ...userA };
		seedSensitiveSessionState(api, imageInputStub);
		currentAuthUser = { ...userB };
		await api.refreshAuth();
		assert.equal(api.user?.id, 'user-b');
		assertClearedSessionState(api, imageInputStub);

		// 5. refreshAuth() household switch: userB (house-b) -> userB (house-shared)
		seedSensitiveSessionState(api, imageInputStub);
		currentAuthUser = { ...userB, householdId: 'house-shared' };
		await api.refreshAuth();
		assert.equal(api.user?.householdId, 'house-shared');
		assertClearedSessionState(api, imageInputStub);

		// 6. refreshAuth() session expiry / sign-out: signed-in -> null
		seedSensitiveSessionState(api, imageInputStub);
		currentAuthUser = null;
		await api.refreshAuth();
		assert.equal(api.user, null);
		assertClearedSessionState(api, imageInputStub);
	} finally {
		harness.dispose();
	}
});

test('handleWindowKeydown Escape dismisses one UI layer at a time instead of clearing underlying state', async () => {
	const harness = createReactivePage();
	try {
		const { api } = harness;
		const recipe = makeRecipe('roast-squash', 'Roast Squash');
		api.kitchen.recipes = [recipe];
		api.user = { ...userA };

		// 1. Escape on Settings layered over RecipeDetail (Nutrition facts) closes Settings only;
		//    a second Escape closes RecipeDetail and resets selectedDetailTab.
		api.selected = recipe;
		api.selectedMealServings = 4;
		api.selectedDetailTab = 'nutrition';
		api.pendingAIContinuation = { kind: 'nutrition', recipeId: 'roast-squash', servings: 4 };
		api.modal = 'settings';

		api.handleWindowKeydown({ key: 'Escape' } as KeyboardEvent);
		assert.equal(api.modal, '');
		assert.equal(api.selected?.id, 'roast-squash');
		assert.equal(api.selectedMealServings, 4);
		assert.equal(api.selectedDetailTab, 'nutrition');

		api.handleWindowKeydown({ key: 'Escape' } as KeyboardEvent);
		assert.equal(api.selected, null);
		assert.equal(api.selectedMealServings, undefined);
		assert.equal(api.selectedDetailTab, 'recipe');

		// 2. Escape when modal is layered over editingRecipe closes modal first, then editingRecipe
		api.editingRecipe = recipe;
		api.editingRecipeMode = 'create';
		api.modal = 'settings';

		api.handleWindowKeydown({ key: 'Escape' } as KeyboardEvent);
		assert.equal(api.modal, '');
		assert.equal(api.editingRecipe?.id, 'roast-squash');
		assert.equal(api.editingRecipeMode, 'create');

		api.handleWindowKeydown({ key: 'Escape' } as KeyboardEvent);
		assert.equal(api.editingRecipe, null);
		assert.equal(api.editingRecipeMode, 'edit');

		// 3. Escape when mobileNav is open over pantryDraft closes mobileNav first, then cancels pantryDraft
		api.pantryDraft = {
			id: 'p-1',
			quantity: 2,
			unit: 'can',
			category: 'Pantry',
			expires: ''
		};
		api.mobileNav = true;

		api.handleWindowKeydown({ key: 'Escape' } as KeyboardEvent);
		assert.equal(api.mobileNav, false);
		assert.equal(api.pantryDraft?.id, 'p-1');

		api.handleWindowKeydown({ key: 'Escape' } as KeyboardEvent);
		assert.equal(api.pantryDraft, null);
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		harness.dispose();
	}
});
