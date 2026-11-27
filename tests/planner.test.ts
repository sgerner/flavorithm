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
import * as aiContinuationMod from '../src/lib/ai-continuation.ts';
import * as butlerActionsMod from '../src/lib/butler-actions.ts';
import * as butlerMod from '../src/lib/butler.ts';
import * as butlerChatMod from '../src/lib/butler-chat.ts';
import * as syncMod from '../src/lib/client-sync.ts';
import * as clientWorkflowsMod from '../src/lib/client-workflows.ts';
import * as coverUploadMod from '../src/lib/cover-upload.ts';
import * as dataMod from '../src/lib/data.ts';
import * as discoveryMod from '../src/lib/discovery.ts';
import * as domainMod from '../src/lib/domain.ts';
import * as formValidationMod from '../src/lib/form-validation.ts';
import * as guestMod from '../src/lib/guest-storage.ts';
import * as importSessionMod from '../src/lib/import-session.ts';
import * as kitchenExportMod from '../src/lib/kitchen-export.ts';
import * as workflowsMod from '../src/lib/kitchen-workflows.ts';
import * as plannerMod from '../src/lib/planner.ts';
import { calendarDayScrollLeft, weekOffsetFromStarts } from '../src/lib/planner.ts';
import * as recipeCollectionMod from '../src/lib/recipe-collection.ts';
import * as coverMod from '../src/lib/recipe-cover.ts';
import * as recipeDetailMod from '../src/lib/recipe-detail.ts';
import * as recipeDraftMod from '../src/lib/recipe-draft.ts';
import * as scraperMod from '../src/lib/recipe-scraper.ts';
import * as stateSchemaMod from '../src/lib/state-schema.ts';
import type { AppState, Meal, Recipe, User } from '../src/lib/types.ts';
import * as voiceCaptureMod from '../src/lib/voice-capture.ts';
import * as voiceConfigMod from '../src/lib/voice-config.ts';

const { MAX_RECIPES } = recipeCollectionMod;

const nodeRequire = createRequire(import.meta.url);
const svelteClient = nodeRequire('svelte/internal/client') as {
	effect_root: (fn: () => void) => () => void;
};
const svelteServer = nodeRequire('svelte/internal/server') as Record<string, unknown>;

// Compile and execute the real planner inside src/routes/+page.svelte rather than a copy of its logic.
const rawPageSource = readFileSync('src/routes/+page.svelte', 'utf8');

function injectPlannerHook(svelteSource: string): string {
	const instanceStart = svelteSource.indexOf('<script lang="ts">');
	assert.notEqual(instanceStart, -1, 'expected instance <script lang="ts"> in +page.svelte');
	const instanceEnd = svelteSource.indexOf('</script>', instanceStart);
	assert.notEqual(instanceEnd, -1, 'expected closing </script> for instance script');
	const hook = `
	(globalThis as any).__onPlannerInit?.({
		get kitchen() { return kitchen; },
		set kitchen(value: AppState) { kitchen = value; },
		get page() { return page; },
		set page(value: string) { page = value; },
		get user() { return user; },
		set user(value: User | null) { user = value; },
		get runtimeAuthMode() { return runtimeAuthMode; },
		set runtimeAuthMode(value: 'local' | 'oidc' | 'proxy' | 'invalid' | null) { runtimeAuthMode = value; },
		get runtimeLogoutUrl() { return runtimeLogoutUrl; },
		set runtimeLogoutUrl(value: string | null) { runtimeLogoutUrl = value; },
		get authMetadataLoaded() { return authMetadataLoaded; },
		set authMetadataLoaded(value: boolean) { authMetadataLoaded = value; },
		get week() { return week; },
		get weekOffset() { return weekOffset; },
		set weekOffset(value: number) { weekOffset = value; },
		get deductPantry() { return deductPantry; },
		set deductPantry(value: boolean) { deductPantry = value; },
		get cookedHistoryLimit() { return cookedHistoryLimit; },
		set cookedHistoryLimit(value: number) { cookedHistoryLimit = value; },
		get recipesById() { return recipesById; },
		get mealsByDateSlot() { return mealsByDateSlot; },
		get completedMeals() { return completedMeals; },
		get renderableCompletedMeals() { return renderableCompletedMeals; },
		get visibleCompletedMeals() { return visibleCompletedMeals; },
		dateKey,
		mealSlotKey,
		formatCompletedDate,
		openRecipePicker,
		choosePickedRecipe,
		openCookDialog,
		markMealCooked,
		showMoreHistory: () => { cookedHistoryLimit += COOKED_HISTORY_PAGE_SIZE; },
		editPlannedMeal,
		saveMealChanges,
		setPlannedDraft: (date: string, slot: string, servings: number) => {
			mealDate = date;
			mealSlot = slot;
			plannedServings = servings;
		},
		useLeftovers: (meal: Meal) => { meal.leftoverServings = 0; },
		rateRecipe: (recipe: Recipe, rating: number) => {
			recipe.rating = rating;
			kitchen.preferences.ratings = { ...(kitchen.preferences.ratings ?? {}), [recipe.id]: rating };
			kitchen.recipes = [...kitchen.recipes];
		},
		get modal() { return modal; },
		set modal(value: string) { modal = value; },
		get pendingExport() { return pendingExport; },
		set pendingExport(value: 'kitchen' | 'shopping' | 'pending' | null) { pendingExport = value; },
		get toast() { return toast; },
		get toastUndo() { return toastUndo; },
		get selected() { return selected; },
		set selected(value: Recipe | null) { selected = value; },
		get editingRecipe() { return editingRecipe; },
		set editingRecipe(value: Recipe | null) { editingRecipe = value; },
		get editingRecipeMode() { return editingRecipeMode; },
		set editingRecipeMode(value: 'create' | 'edit') { editingRecipeMode = value; },
		get pendingSync() { return pendingSync; },
		set pendingSync(value: boolean) { pendingSync = value; },
		setPendingSyncSnapshot: (localState: AppState | null) => {
			const plainLocal = localState ? (JSON.parse(JSON.stringify(localState)) as AppState) : null;
			kitchenSync = plainLocal
				? ({
						snapshot: () => ({
							userId: user?.id ?? 'u-1',
							householdId: user?.householdId ?? 'h-1',
							local: plainLocal,
							base: createNewUserState(),
							etag: 'etag-1',
							updatedAt: '2026-11-24T12:00:00.000Z'
						}),
						clearContext: () => {},
						quarantined: () => [],
						stage: () => {},
						flush: async () => {}
					} as any)
				: null;
		},
		setApiKey: (value: string) => {
			apiKey = value;
		},
		askButler,
		applyButler,
		openButlerControl,
		confirmPendingExport,
		openNewRecipe,
		closeDialog,
		logout,
		set deletePassword(value: string) { deletePassword = value; },
		deleteAccount,
		exportKitchen,
		exportPendingChanges,
		startPantryEdit,
		setPantryDraftQuantity: (value: string) => {
			if (pantryDraft) pantryDraft.quantity = value;
		},
		get toastActionLabel() { return toastActionLabel; },
		get online() { return online; },
		set online(value: boolean) { online = value; },
		get ready() { return ready; },
		set ready(value: boolean) { ready = value; },
		get kitchenLoaded() { return kitchenLoaded; },
		set kitchenLoaded(value: boolean) { kitchenLoaded = value; },
		initKitchenSyncForTest: (initialUser: User, baseline: AppState, etag = 'etag-test') => {
			kitchenSync = createKitchenSync({
				storage: localStorage,
				getUser: () => user,
				getState: () => sanitizeKitchenState(JSON.parse(JSON.stringify(kitchen))),
				setState: (state) => {
					kitchen = sanitizeKitchenState(state);
				},
				onStatus: (status) => {
					syncReady = status.ready;
					pendingSync = status.pending;
					sendingSync = status.syncing;
					conflicts = status.conflicts;
					reviewedEtag = status.reviewedEtag;
					syncErrors = status.error;
				},
				transport: () => {
					throw new Error('Unused transport in export test');
				}
			});
			kitchenSync.initialize(initialUser, baseline, etag);
		}
	});
`;
	return svelteSource.slice(0, instanceEnd) + hook + svelteSource.slice(instanceEnd);
}

const hookedPageSource = injectPlannerHook(rawPageSource);
const serverJs = ts.transpileModule(
	compile(hookedPageSource, { filename: 'src/routes/+page.svelte', generate: 'server' }).js.code,
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

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

type PlannerHarnessApi = {
	kitchen: AppState;
	page: string;
	user: User | null;
	runtimeAuthMode: 'local' | 'oidc' | 'proxy' | 'invalid' | null;
	runtimeLogoutUrl: string | null;
	authMetadataLoaded: boolean;
	readonly week: Date[];
	weekOffset: number;
	deductPantry: boolean;
	cookedHistoryLimit: number;
	readonly recipesById: Map<string, Recipe>;
	readonly mealsByDateSlot: Map<string, Meal[]>;
	readonly completedMeals: Meal[];
	readonly renderableCompletedMeals: Meal[];
	readonly visibleCompletedMeals: Meal[];
	dateKey: (date: Date) => string;
	mealSlotKey: (date: string, slot: string) => string;
	formatCompletedDate: (
		value: string | undefined,
		formatter: Intl.DateTimeFormat,
		fallback?: string
	) => string;
	openRecipePicker: (slotTarget?: { date: string; slot: string }) => void;
	choosePickedRecipe: (recipe: Recipe) => void;
	openCookDialog: (meal: Meal) => void;
	markMealCooked: (event?: SubmitEvent) => Promise<void>;
	showMoreHistory: () => void;
	editPlannedMeal: (meal: Meal) => void;
	saveMealChanges: () => void;
	setPlannedDraft: (date: string, slot: string, servings: number) => void;
	useLeftovers: (meal: Meal) => void;
	rateRecipe: (recipe: Recipe, rating: number) => void;
	modal: string;
	pendingExport: 'kitchen' | 'shopping' | 'pending' | null;
	readonly toast: string;
	readonly toastUndo: (() => void) | null;
	selected: Recipe | null;
	editingRecipe: Recipe | null;
	editingRecipeMode: 'create' | 'edit';
	pendingSync: boolean;
	setPendingSyncSnapshot: (localState: AppState | null) => void;
	setApiKey: (value: string) => void;
	askButler: (
		message: string,
		history: butlerChatMod.ButlerTurn[],
		signal?: AbortSignal,
		recipeDrafts?: Recipe[]
	) => Promise<butlerChatMod.ButlerChatResult | null>;
	applyButler: (commands: unknown[], expectedSnapshot: string) => string;
	openButlerControl: (
		target: Extract<butlerMod.ButlerCommand, { type: 'ui' }>['action']
	) => boolean;
	confirmPendingExport: () => Promise<void>;
	openNewRecipe: () => void;
	closeDialog: () => void;
	logout: () => Promise<void>;
	deletePassword: string;
	deleteAccount: (event: SubmitEvent) => Promise<void>;
	exportKitchen: () => Promise<void>;
	exportPendingChanges: () => void;
	startPantryEdit: (item: AppState['pantry'][number]) => Promise<void>;
	setPantryDraftQuantity: (value: string) => void;
	readonly toastActionLabel: string;
	online: boolean;
	ready: boolean;
	kitchenLoaded: boolean;
	initKitchenSyncForTest: (initialUser: User, baseline: AppState, etag?: string) => void;
};

const noopComponent = () => {};
const iconProxy = new Proxy({}, { get: () => noopComponent });

function createModuleMap() {
	return {
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
		'#lib/components/FormField.svelte': { __esModule: true, default: noopComponent },
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
		'#lib/butler.ts': butlerMod,
		'#lib/butler-actions.ts': butlerActionsMod,
		'#lib/butler-chat.ts': butlerChatMod,
		'#lib/voice-capture.ts': { ...voiceCaptureMod, VoiceCapture: class {} },
		'#lib/voice-config.ts': voiceConfigMod,
		'#lib/ai-connections.ts': aiConnectionsMod,
		'#lib/client-workflows.ts': clientWorkflowsMod,
		'#lib/guest-storage.ts': guestMod,
		'#lib/kitchen-export.ts': kitchenExportMod,
		'#lib/client-sync.ts': syncMod,
		'#lib/recipe-scraper.ts': scraperMod,
		'#lib/state-schema.ts': stateSchemaMod,
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
	} as Record<string, unknown>;
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

function renderPlannerHtml(setup: (api: PlannerHarnessApi) => void, customDate?: unknown) {
	const modMap = createModuleMap();
	const exports: { default?: any } = {};
	let captured!: PlannerHarnessApi;
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			if (id.startsWith('#lib/components/') && id.endsWith('.svelte')) {
				return { __esModule: true, default: noopComponent };
			}
			throw new Error(`Unexpected planner dependency ${id}`);
		},
		Date: customDate ?? Date,
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
	sandbox.__onPlannerInit = (api: PlannerHarnessApi) => {
		captured = api;
		api.page = 'planner';
		setup(api);
	};
	runInNewContext(serverJs, sandbox);
	const rendered = render(exports.default, {
		props: { data: { authMode: 'local', loginUrl: null, logoutUrl: null } }
	});
	return { html: rendered.body, api: captured };
}

function createReactivePlanner(options?: { fetch?: typeof fetch; onLine?: boolean }) {
	const modMap = createModuleMap();
	const exports: { default?: any } = {};
	let api!: PlannerHarnessApi;
	const assignedUrls: string[] = [];
	const downloads: Array<{ filename: string; content: string; type: string }> = [];
	const blobUrls = new Map<string, { content: string; type: string }>();
	let blobSeq = 0;
	const aiRequests: Record<string, unknown>[] = [];
	let aiResponse: butlerChatMod.ButlerChatResult = { reply: 'Ready.', commands: [] };
	const storage = makeMemoryStorage();
	const navigatorState = { onLine: options?.onLine ?? true };
	let fetchImpl: typeof fetch =
		options?.fetch ??
		(async (input: unknown, init?: RequestInit) => {
			const path = String(input);
			if (path === '/api/export') {
				return new Response(
					JSON.stringify({
						exportedAt: '2026-11-24T18:00:00.000Z',
						user: api?.user ?? undefined,
						state: api ? JSON.parse(JSON.stringify(api.kitchen)) : dataMod.createNewUserState()
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				);
			}
			if (path === '/api/ai') {
				if (typeof init?.body === 'string') {
					aiRequests.push(JSON.parse(init.body) as Record<string, unknown>);
				}
				return new Response(JSON.stringify(aiResponse), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		});
	class RecordedBlob {
		readonly textContent: string;
		readonly type: string;
		constructor(parts: Array<unknown> = [], init?: { type?: string }) {
			this.textContent = parts.map((part) => String(part)).join('');
			this.type = init?.type ?? '';
		}
		async text() {
			return this.textContent;
		}
	}
	const customUrl = Object.assign(
		function URLProxy(input: string | URL, base?: string | URL) {
			return new URL(input, base);
		},
		{
			canParse: URL.canParse?.bind(URL),
			parse: URL.parse?.bind(URL),
			createObjectURL: (blob: unknown) => {
				const token = `blob:test-${++blobSeq}`;
				const recorded = blob as RecordedBlob;
				blobUrls.set(token, {
					content: typeof recorded?.textContent === 'string' ? recorded.textContent : '',
					type: typeof recorded?.type === 'string' ? recorded.type : ''
				});
				return token;
			},
			revokeObjectURL: (url: string) => {
				blobUrls.delete(url);
			}
		}
	);
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			if (id.startsWith('#lib/components/') && id.endsWith('.svelte')) {
				return { __esModule: true, default: noopComponent };
			}
			throw new Error(`Unexpected planner dependency ${id}`);
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
		TypeError,
		RangeError,
		DOMException,
		AbortSignal,
		Blob: RecordedBlob,
		CSS: { escape: (value: string) => value },
		Promise,
		URL: customUrl,
		Response,
		Request,
		crypto,
		console,
		setTimeout: (fn: (...args: unknown[]) => void, ms?: number) => setTimeout(fn, ms).unref(),
		clearTimeout,
		setInterval,
		clearInterval,
		localStorage: storage,
		navigator: navigatorState,
		document: {
			documentElement: {
				dataset: {},
				classList: { toggle: () => {} }
			},
			querySelector: () => null,
			createElement: (tag: string) => {
				const anchor = {
					tag,
					href: '',
					download: '',
					click: () => {
						const payload = blobUrls.get(anchor.href);
						downloads.push({
							filename: anchor.download,
							content: payload?.content ?? '',
							type: payload?.type ?? ''
						});
					}
				};
				return anchor;
			}
		},
		window: {
			location: {
				assign: (url: string) => assignedUrls.push(url),
				reload: () => {}
			},
			scrollTo: () => {}
		},
		fetch: (...args: Parameters<typeof fetch>) => fetchImpl(...args)
	};
	sandbox.globalThis = sandbox;
	sandbox.__onPlannerInit = (instance: PlannerHarnessApi) => {
		api = instance;
	};
	runInNewContext(clientScriptJs, sandbox);
	const dispose = svelteClient.effect_root(() => {
		exports.default(null, { data: { authMode: 'local', loginUrl: null, logoutUrl: null } });
	});
	return {
		api,
		assignedUrls,
		downloads,
		aiRequests,
		setAiResponse: (next: butlerChatMod.ButlerChatResult) => {
			aiResponse = next;
		},
		navigatorState,
		setFetch: (next: typeof fetch) => {
			fetchImpl = next;
		},
		storage,
		dispose
	};
}

test('unmodified +page.svelte compiles cleanly and avoids linear recipe scans and per-item toLocaleDateString in planner', () => {
	const compiled = compile(rawPageSource, {
		filename: 'src/routes/+page.svelte',
		generate: 'server'
	});
	assert.equal(compiled.warnings.length, 0);

	const plannerStart = rawPageSource.indexOf("{:else if page === 'planner'}");
	const shoppingStart = rawPageSource.indexOf("{:else if page === 'shopping'}");
	assert.notEqual(plannerStart, -1);
	assert.notEqual(shoppingStart, -1);
	const plannerMarkup = rawPageSource.slice(plannerStart, shoppingStart);

	// Calendar slots and cooked history should not run linear recipes.find or per-row toLocaleDateString.
	const gridStart = plannerMarkup.indexOf('class="calendar-grid"');
	assert.notEqual(gridStart, -1);
	const gridAndHistory = plannerMarkup.slice(gridStart);
	assert.equal(gridAndHistory.includes('recipes.find'), false);
	assert.equal(gridAndHistory.includes('toLocaleDateString'), false);
});

test('planner partitions 1,000 meals and 250 recipes in one meal pass with slot grouping and zero linear recipe finds', () => {
	let mealIterations = 0;
	let recipeFindCalls = 0;
	let toLocaleDateCalls = 0;
	let getFullYearCalls = 0;

	class CountingDate extends Date {
		override getFullYear(): number {
			getFullYearCalls++;
			return super.getFullYear();
		}
		override toLocaleDateString(
			locales?: Intl.LocalesArgument,
			options?: Intl.DateTimeFormatOptions
		): string {
			toLocaleDateCalls++;
			return super.toLocaleDateString(locales, options);
		}
	}

	const recipes = Array.from({ length: MAX_RECIPES }, (_, index) =>
		makeRecipe(`r-${index}`, `Dish ${index}`)
	);
	Object.defineProperty(recipes, 'find', {
		value: () => {
			recipeFindCalls++;
			throw new Error('planner should resolve recipes through recipesById instead of recipes.find');
		}
	});

	const { html, api } = renderPlannerHtml((planner) => {
		const weekDays = planner.week.map((day) => planner.dateKey(day));
		const baseMeals: Meal[] = [
			{
				id: 'slot-b1',
				date: weekDays[0],
				slot: 'Breakfast',
				recipeId: 'r-1',
				servings: 2
			},
			{
				id: 'slot-b2',
				date: weekDays[0],
				slot: 'Breakfast',
				recipeId: 'r-2',
				servings: 3,
				completedAt: '2026-11-16T08:30:00.000Z'
			},
			{
				id: 'slot-d1',
				date: weekDays[3],
				slot: 'Dinner',
				recipeId: 'r-4',
				servings: 4
			}
		];
		for (let i = baseMeals.length; i < 1000; i++) {
			baseMeals.push({
				id: `hist-${i}`,
				date: '2026-10-01',
				slot: 'Dinner',
				recipeId: `r-${i % MAX_RECIPES}`,
				servings: 2,
				completedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()
			});
		}
		const trackedMeals = new Proxy(baseMeals, {
			get(target, prop, receiver) {
				if (prop === Symbol.iterator) {
					return function* () {
						mealIterations++;
						yield* target;
					};
				}
				if (prop === 'filter' || prop === 'some') {
					throw new Error(`planner should not scan kitchen.meals.${String(prop)} during render`);
				}
				return Reflect.get(target, prop, receiver);
			}
		});
		planner.kitchen = {
			...dataMod.createNewUserState(),
			recipes,
			meals: trackedMeals
		};
	}, CountingDate);

	assert.equal(mealIterations, 1, 'kitchen.meals should be scanned once per planner render');
	assert.equal(recipeFindCalls, 0, 'recipes.find should never be called in planner render');
	// Only the two week-range bounds in the toolbar heading use toLocaleDateString.
	assert.equal(toLocaleDateCalls, 2);
	// setup called dateKey 7 times; render called dateKey once for todayKey and once per day (7) = 15 total.
	assert.equal(getFullYearCalls, 15);

	const mondayKey = api.dateKey(api.week[0]);
	const thursdayKey = api.dateKey(api.week[3]);
	assert.deepEqual(
		Array.from(api.mealsByDateSlot.get(api.mealSlotKey(mondayKey, 'Breakfast')) ?? [], (m) => m.id),
		['slot-b1', 'slot-b2']
	);
	assert.deepEqual(
		Array.from(api.mealsByDateSlot.get(api.mealSlotKey(thursdayKey, 'Dinner')) ?? [], (m) => m.id),
		['slot-d1']
	);

	assert.match(html, /Dish 1/);
	assert.match(html, /Dish 2/);
	assert.match(html, /Dish 4/);
	assert.match(html, /Cooked Nov 16/);
	assert.match(html, />998 meals</);
	assert.equal((html.match(/class="cooked-history-row[\s"]/g) ?? []).length, 20);
	assert.match(html, />Show more<\/button>/);
});

test('completedMeals sorts descending, skips missing recipes before slicing, and guards malformed completedAt values', () => {
	const recipes = Array.from({ length: 25 }, (_, index) =>
		makeRecipe(`rec-${index}`, `Meal Title ${String(index).padStart(2, '0')}`)
	);

	const meals: Meal[] = [];
	// Add 3 orphaned completed meals with the newest timestamps so they sit inside the top 20 of completedMeals.
	for (let orphan = 0; orphan < 3; orphan++) {
		meals.push({
			id: `orphan-${orphan}`,
			date: '2026-11-20',
			slot: 'Dinner',
			recipeId: `deleted-recipe-${orphan}`,
			servings: 2,
			completedAt: `2026-11-21T23:5${orphan}:00.000Z`
		});
	}
	// Add 22 valid completed meals in scrambled order, including one malformed completedAt string.
	const validIndices = [
		5, 19, 0, 12, 21, 3, 14, 8, 1, 17, 20, 10, 2, 15, 6, 18, 11, 4, 16, 7, 13, 9
	];
	for (const index of validIndices) {
		meals.push({
			id: `valid-${index}`,
			date: '2026-11-18',
			slot: 'Lunch',
			recipeId: `rec-${index}`,
			servings: 2,
			leftoverServings: index === 21 ? 1 : 0,
			completedAt:
				index === 0
					? 'malformed-timestamp'
					: `2026-11-${String((index % 20) + 1).padStart(2, '0')}T18:00:00.000Z`
		});
	}

	const { html, api } = renderPlannerHtml((planner) => {
		// Also place an orphaned meal and a malformed-timestamp cooked meal in the active calendar week.
		const todayKey = planner.dateKey(planner.week[0]);
		meals.push(
			{
				id: 'calendar-orphan',
				date: todayKey,
				slot: 'Breakfast',
				recipeId: 'missing-calendar-recipe',
				servings: 2
			},
			{
				id: 'calendar-bad-date',
				date: todayKey,
				slot: 'Dinner',
				recipeId: 'rec-24',
				servings: 2,
				completedAt: 'not-a-valid-date'
			}
		);
		planner.kitchen = {
			...dataMod.createNewUserState(),
			recipes,
			meals
		};
	});

	// Total completedMeals includes 3 orphaned + 22 valid + 1 calendar-bad-date = 26.
	assert.equal(api.completedMeals.length, 26);
	assert.match(html, />26 meals</);

	// Verify descending completedAt sort order.
	for (let i = 1; i < api.completedMeals.length; i++) {
		const prev = api.completedMeals[i - 1].completedAt ?? '';
		const curr = api.completedMeals[i].completedAt ?? '';
		assert.ok(prev.localeCompare(curr) >= 0, `expected ${prev} >= ${curr}`);
	}

	// Renderable completed meals exclude the 3 orphaned entries (23 renderable), so initial slice still has a full 20 rows.
	assert.equal(api.renderableCompletedMeals.length, 23);
	assert.equal(api.visibleCompletedMeals.length, 20);
	assert.equal((html.match(/class="cooked-history-row[\s"]/g) ?? []).length, 20);
	assert.equal(html.includes('deleted-recipe-'), false);
	assert.equal(html.includes('missing-calendar-recipe'), false);

	// Malformed completedAt strings render safe fallbacks without throwing RangeError.
	assert.match(html, /<small class="cooked-badge[^"]*">Cooked<\/small>/);
	assert.match(html, /Unknown date · 2\s+servings/);
	assert.match(html, />Show more<\/button>/);

	// When total completedMeals > 20 (22) but renderable rows <= 20 (19), header shows 22 meals and hides Show more.
	const belowThreshold = renderPlannerHtml((planner) => {
		const mixedMeals: Meal[] = [
			...Array.from({ length: 3 }, (_, i) => ({
				id: `missing-${i}`,
				date: '2026-11-20',
				slot: 'Dinner',
				recipeId: `nonexistent-${i}`,
				servings: 2,
				completedAt: `2026-11-21T20:0${i}:00.000Z`
			})),
			...Array.from({ length: 19 }, (_, i) => ({
				id: `present-${i}`,
				date: '2026-11-19',
				slot: 'Dinner',
				recipeId: `rec-${i}`,
				servings: 2,
				completedAt: `2026-11-${String(i + 1).padStart(2, '0')}T18:00:00.000Z`
			}))
		];
		planner.kitchen = {
			...dataMod.createNewUserState(),
			recipes,
			meals: mixedMeals
		};
	});
	assert.match(belowThreshold.html, />22 meals</);
	assert.equal((belowThreshold.html.match(/class="cooked-history-row[\s"]/g) ?? []).length, 19);
	assert.equal(belowThreshold.html.includes('>Show more</button>'), false);
});

test('incremental history slicing reveals 20 rows per click, preserves limit across edits, and resets on logout and deleteAccount', async () => {
	const harness = createReactivePlanner();
	try {
		const { api } = harness;
		const recipes = Array.from({ length: 10 }, (_, i) => makeRecipe(`r-${i}`, `Recipe ${i}`));
		const meals: Meal[] = Array.from({ length: 45 }, (_, i) => ({
			id: `m-${i}`,
			date: '2026-11-10',
			slot: 'Dinner',
			recipeId: `r-${i % 10}`,
			servings: 4,
			leftoverServings: i === 25 ? 2 : 0,
			completedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()
		}));
		// Include 2 orphaned meals at the very top to confirm reactive slicing still yields 20 -> 40 -> 45.
		meals.push(
			{
				id: 'orphan-a',
				date: '2026-11-11',
				slot: 'Dinner',
				recipeId: 'missing-a',
				servings: 2,
				completedAt: '2026-12-01T10:00:00.000Z'
			},
			{
				id: 'orphan-b',
				date: '2026-11-11',
				slot: 'Lunch',
				recipeId: 'missing-b',
				servings: 2,
				completedAt: '2026-12-01T11:00:00.000Z'
			}
		);

		api.page = 'planner';
		api.kitchen = {
			...dataMod.createNewUserState(),
			recipes,
			meals
		};

		assert.equal(api.completedMeals.length, 47);
		assert.equal(api.renderableCompletedMeals.length, 45);
		assert.equal(api.cookedHistoryLimit, 20);
		assert.equal(api.visibleCompletedMeals.length, 20);
		assert.equal(api.visibleCompletedMeals[0].id, 'm-44');
		assert.equal(api.visibleCompletedMeals[19].id, 'm-25');

		// First "Show more" click reveals 20 older rows (40 total).
		api.showMoreHistory();
		assert.equal(api.cookedHistoryLimit, 40);
		assert.equal(api.visibleCompletedMeals.length, 40);
		assert.equal(api.visibleCompletedMeals[39].id, 'm-5');

		// Leftover and rating edits preserve the expanded 40-row limit.
		const mealWithLeftovers = api.visibleCompletedMeals.find((m) => m.id === 'm-25')!;
		assert.equal(mealWithLeftovers.leftoverServings, 2);
		api.useLeftovers(mealWithLeftovers);
		assert.equal(mealWithLeftovers.leftoverServings, 0);
		assert.equal(api.cookedHistoryLimit, 40);
		assert.equal(api.visibleCompletedMeals.length, 40);

		const targetRecipe = api.recipesById.get('r-0')!;
		api.rateRecipe(targetRecipe, 5);
		assert.equal(api.recipesById.get('r-0')?.rating, 5);
		assert.equal(api.cookedHistoryLimit, 40);
		assert.equal(api.visibleCompletedMeals.length, 40);

		// Second "Show more" click reveals remaining 5 rows (limit 60, 45 visible).
		api.showMoreHistory();
		assert.equal(api.cookedHistoryLimit, 60);
		assert.equal(api.visibleCompletedMeals.length, 45);
		assert.equal(api.visibleCompletedMeals[44].id, 'm-0');

		// Verify SSR hides "Show more" once cookedHistoryLimit >= renderableCompletedMeals.length.
		const expandedRender = renderPlannerHtml((planner) => {
			planner.kitchen = { ...dataMod.createNewUserState(), recipes, meals };
			planner.cookedHistoryLimit = 60;
		});
		assert.equal((expandedRender.html.match(/class="cooked-history-row[\s"]/g) ?? []).length, 45);
		assert.equal(expandedRender.html.includes('>Show more</button>'), false);

		// Local logout resets cookedHistoryLimit back to 20.
		api.user = {
			id: 'u-1',
			name: 'Alex',
			email: 'alex@example.test',
			householdId: 'h-1'
		};
		await api.logout();
		assert.equal(api.cookedHistoryLimit, 20);

		// Managed-auth logout also resets cookedHistoryLimit back to 20.
		api.cookedHistoryLimit = 60;
		api.runtimeAuthMode = 'oidc';
		api.runtimeLogoutUrl = 'https://idp.example.test/logout';
		api.authMetadataLoaded = true;
		await api.logout();
		assert.equal(api.cookedHistoryLimit, 20);
		assert.deepEqual(harness.assignedUrls, ['https://idp.example.test/logout']);

		// deleteAccount resets cookedHistoryLimit back to 20.
		api.runtimeAuthMode = 'local';
		api.cookedHistoryLimit = 40;
		api.user = {
			id: 'u-2',
			name: 'Sam',
			email: 'sam@example.test',
			householdId: 'h-2'
		};
		api.deletePassword = 'valid-password';
		await api.deleteAccount({ preventDefault: () => {} } as SubmitEvent);
		assert.equal(api.cookedHistoryLimit, 20);
	} finally {
		harness.dispose();
	}
});

test('editing a planned meal updates mealsByDateSlot reactively', () => {
	const harness = createReactivePlanner();
	try {
		const { api } = harness;
		const recipe = makeRecipe('r-move', 'Moveable Pasta');
		const monday = api.dateKey(api.week[0]);
		const wednesday = api.dateKey(api.week[2]);
		const meal: Meal = {
			id: 'meal-move',
			date: monday,
			slot: 'Lunch',
			recipeId: recipe.id,
			servings: 2
		};
		api.kitchen = {
			...dataMod.createNewUserState(),
			recipes: [recipe],
			meals: [meal]
		};

		assert.equal(api.mealsByDateSlot.get(api.mealSlotKey(monday, 'Lunch'))?.length, 1);
		assert.equal(api.mealsByDateSlot.get(api.mealSlotKey(wednesday, 'Dinner')), undefined);

		api.editPlannedMeal(api.kitchen.meals[0]);
		api.setPlannedDraft(wednesday, 'Dinner', 4);
		api.saveMealChanges();

		assert.equal(api.mealsByDateSlot.get(api.mealSlotKey(monday, 'Lunch')), undefined);
		const moved = api.mealsByDateSlot.get(api.mealSlotKey(wednesday, 'Dinner'));
		assert.equal(moved?.length, 1);
		assert.equal(moved?.[0].servings, 4);
	} finally {
		harness.dispose();
	}
});

test('choosing a recipe for a planner slot keeps valid servings above 24', () => {
	const harness = createReactivePlanner();
	try {
		const { api } = harness;
		const recipe = makeRecipe('r-large-pot', 'Large Pot Pasta');
		recipe.servings = 250;
		const scheduledDate = '2026-11-23';
		api.kitchen = { ...dataMod.createNewUserState(), recipes: [recipe], meals: [] };

		api.openRecipePicker({ date: scheduledDate, slot: 'Lunch' });
		api.choosePickedRecipe(recipe);

		assert.equal(api.kitchen.meals.length, 1);
		assert.equal(api.kitchen.meals[0].date, scheduledDate);
		assert.equal(api.kitchen.meals[0].slot, 'Lunch');
		assert.equal(api.kitchen.meals[0].recipeId, recipe.id);
		assert.equal(api.kitchen.meals[0].servings, 250);
	} finally {
		harness.dispose();
	}
});

test('marking a meal cooked keeps pantry deduction opt-in', async () => {
	const harness = createReactivePlanner();
	try {
		const { api } = harness;
		const recipe = makeRecipe('r-cook', 'Weeknight Pasta');
		recipe.ingredients = [
			{ name: 'olive oil', quantity: 1, unit: 'tbsp' },
			{ name: 'garlic', quantity: 2, unit: 'clove' }
		];
		const firstMeal: Meal = {
			id: 'meal-cook-1',
			date: '2026-11-23',
			slot: 'Dinner',
			recipeId: recipe.id,
			servings: recipe.servings
		};
		const secondMeal: Meal = {
			id: 'meal-cook-2',
			date: '2026-11-24',
			slot: 'Dinner',
			recipeId: recipe.id,
			servings: recipe.servings
		};
		api.kitchen = {
			...dataMod.createNewUserState(),
			pantry: [{ id: 'p-oil', name: 'olive oil', quantity: 4, unit: 'tbsp', category: 'Pantry' }],
			recipes: [recipe],
			meals: [firstMeal, secondMeal],
			shopping: [
				{
					id: 'checked-garlic',
					name: 'garlic',
					quantity: 2,
					unit: 'clove',
					checked: true,
					sourceKey: 'week:2026-11-23'
				}
			]
		};

		api.openCookDialog(firstMeal);
		assert.equal(api.deductPantry, false);

		await api.markMealCooked();
		assert.ok(api.kitchen.meals.find((item) => item.id === firstMeal.id)?.completedAt);
		assert.equal(api.kitchen.pantry[0].quantity, 4);
		assert.equal(api.kitchen.shopping.find((item) => item.id === 'checked-garlic')?.quantity, 2);
		assert.equal(api.deductPantry, false);

		api.openCookDialog(secondMeal);
		assert.equal(api.deductPantry, false);
		api.deductPantry = true;
		assert.equal(api.deductPantry, true);

		api.openCookDialog(secondMeal);
		assert.equal(api.deductPantry, false);

		api.deductPantry = true;
		await api.markMealCooked();
		assert.ok(api.kitchen.meals.find((item) => item.id === secondMeal.id)?.completedAt);
		assert.equal(api.kitchen.pantry[0].quantity, 3);
		assert.equal(
			api.kitchen.shopping.some((item) => item.id === 'checked-garlic'),
			false
		);
		assert.equal(api.deductPantry, false);
	} finally {
		harness.dispose();
	}
});

function dateKeyForTest(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function weekStartForTest(value: string) {
	const date = new Date(`${value}T12:00:00`);
	if (Number.isNaN(date.getTime())) return value;
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return dateKeyForTest(date);
}

test('weekOffsetFromStarts computes Monday-relative week offsets across weekdays and DST boundaries', () => {
	const todayMonday = weekStartForTest('2026-11-19'); // Thursday -> 2026-11-16
	assert.equal(todayMonday, '2026-11-16');

	assert.equal(weekOffsetFromStarts(weekStartForTest('2026-11-16'), todayMonday), 0);
	assert.equal(weekOffsetFromStarts(weekStartForTest('2026-11-22'), todayMonday), 0);
	assert.equal(weekOffsetFromStarts(weekStartForTest('2026-11-24'), todayMonday), 1);
	assert.equal(weekOffsetFromStarts(weekStartForTest('2026-11-15'), todayMonday), -1);

	// Across US fall-back DST boundary (2026-11-01) and spring-forward DST boundary (2026-03-08)
	assert.equal(
		weekOffsetFromStarts(weekStartForTest('2026-11-04'), weekStartForTest('2026-10-28')),
		1
	);
	assert.equal(
		weekOffsetFromStarts(weekStartForTest('2026-03-11'), weekStartForTest('2026-03-04')),
		1
	);

	// Invalid date strings fall back safely to 0
	assert.equal(weekOffsetFromStarts('not-a-date', todayMonday), 0);
});

test('calendarDayScrollLeft preserves phone 16px inline snap gutter and handles existing scrollLeft', () => {
	// 390px phone viewport: grid has margin 0 -16px, padding 0 16px, scroll-padding-inline 16px,
	// 340px cards with 8px gap -> stride 348px; scrollWidth = 16 + 7*340 + 6*8 + 16 = 2460, clientWidth = 390
	const phoneMetrics = {
		gridLeft: 0,
		clientLeft: 0,
		scrollPaddingStart: 16,
		scrollWidth: 2460,
		clientWidth: 390
	};

	// Monday (index 0) at scrollLeft = 0 -> left = 0
	assert.equal(calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 0, dayLeft: 16 }), 0);

	// Thursday (index 3) at scrollLeft = 0 -> dayLeft = 16 + 3*348 = 1060 -> left = 1044
	assert.equal(calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 0, dayLeft: 1060 }), 1044);

	// Returning to Thursday when currently scrolled to Sunday (scrollLeft = 2070):
	// dayLeft in viewport is 1060 - 2070 = -1010 -> still computes exact left = 1044
	assert.equal(calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 2070, dayLeft: -1010 }), 1044);

	// Sunday (index 6) clamps cleanly to maxLeft = 2460 - 390 = 2070
	assert.equal(
		calendarDayScrollLeft({ ...phoneMetrics, scrollLeft: 0, dayLeft: 16 + 6 * 348 }),
		2070
	);
});

test('calendarDayScrollLeft aligns tablet cards inside border-left and clamps at max scroll', () => {
	// 768px tablet viewport: 1px border-left, 0 inline padding, 164px cards, 0 gap
	const tabletMetrics = {
		gridLeft: 218,
		clientLeft: 1,
		scrollPaddingStart: 0,
		scrollWidth: 1148,
		clientWidth: 520
	};

	// Wednesday (index 2): dayLeft = 219 + 2*164 = 547 -> left = 328
	assert.equal(calendarDayScrollLeft({ ...tabletMetrics, scrollLeft: 0, dayLeft: 547 }), 328);

	// Sunday (index 6): rawLeft = 984 -> clamped to 1148 - 520 = 628
	assert.equal(
		calendarDayScrollLeft({ ...tabletMetrics, scrollLeft: 0, dayLeft: 219 + 6 * 164 }),
		628
	);
});

test('Butler sign-out modal, export confirmation modal, and undo-toast presence render accurately in +page.svelte', () => {
	// 1. Sign-out modal for signed-in local user
	const signedInSignOut = renderPlannerHtml((planner) => {
		planner.user = {
			id: 'u-local',
			name: 'Alex',
			email: 'alex@example.test',
			householdId: 'h-local'
		};
		planner.runtimeAuthMode = 'local';
		planner.applyButler([{ type: 'ui', action: 'sign-out' }], JSON.stringify(planner.kitchen));
	});
	assert.equal(signedInSignOut.api.modal, 'signOut');
	assert.equal(signedInSignOut.api.toastUndo, null);
	assert.match(signedInSignOut.html, /Sign out of your kitchen\?/);
	assert.match(signedInSignOut.html, />Stay signed in<\/button>/);
	assert.match(signedInSignOut.html, /Sign out<\/button>/);
	assert.doesNotMatch(signedInSignOut.html, />Undo<\/button>/);

	// 2. Sign-out modal for managed proxy user without logout URL and signed-out guest
	const proxySignOut = renderPlannerHtml((planner) => {
		planner.user = {
			id: 'u-proxy',
			name: 'Pat',
			email: 'pat@example.test',
			householdId: 'h-proxy'
		};
		planner.runtimeAuthMode = 'proxy';
		planner.runtimeLogoutUrl = null;
		planner.modal = 'signOut';
	});
	assert.match(proxySignOut.html, /Sign-out is managed by your organization's access proxy\./);

	const guestSignOut = renderPlannerHtml((planner) => {
		planner.user = null;
		planner.modal = 'signOut';
	});
	assert.match(guestSignOut.html, /You are already signed out on this device\./);

	// 3. Export modal across shopping, kitchen, and pending (disabled vs enabled)
	const shoppingExport = renderPlannerHtml((planner) => {
		planner.kitchen.shopping = [
			{ id: 's-1', name: 'Lemons', quantity: 3, unit: 'each', checked: false }
		];
		planner.applyButler(
			[{ type: 'ui', action: 'export-shopping' }],
			JSON.stringify(planner.kitchen)
		);
	});
	assert.equal(shoppingExport.api.modal, 'export');
	assert.equal(shoppingExport.api.pendingExport, 'shopping');
	assert.equal(shoppingExport.api.toastUndo, null);
	assert.match(shoppingExport.html, /Export shopping list\?/);
	assert.match(shoppingExport.html, /flavorithm-shopping\.txt/);
	assert.doesNotMatch(shoppingExport.html, />Undo<\/button>/);

	const kitchenExport = renderPlannerHtml((planner) => {
		planner.applyButler(
			[{ type: 'ui', action: 'export-kitchen' }],
			JSON.stringify(planner.kitchen)
		);
	});
	assert.equal(kitchenExport.api.modal, 'export');
	assert.equal(kitchenExport.api.pendingExport, 'kitchen');
	assert.match(kitchenExport.html, /Export kitchen data\?/);
	assert.match(kitchenExport.html, /flavorithm-kitchen\.json/);

	const emptyPendingExport = renderPlannerHtml((planner) => {
		planner.pendingSync = false;
		planner.applyButler(
			[{ type: 'ui', action: 'export-pending' }],
			JSON.stringify(planner.kitchen)
		);
	});
	assert.match(
		emptyPendingExport.html,
		/There are no unsynced pending changes to export right now\./
	);
	const emptyPendingDialog = emptyPendingExport.html.slice(
		emptyPendingExport.html.indexOf('aria-label="Export data"')
	);
	assert.equal(emptyPendingDialog.includes('<button class="primary" disabled'), true);
	assert.equal(emptyPendingDialog.includes('Export pending changes</button>'), true);

	const activePendingExport = renderPlannerHtml((planner) => {
		planner.pendingSync = true;
		planner.applyButler(
			[{ type: 'ui', action: 'export-pending' }],
			JSON.stringify(planner.kitchen)
		);
	});
	assert.match(activePendingExport.html, /flavorithm-kitchen\.json/);
	const activePendingDialog = activePendingExport.html.slice(
		activePendingExport.html.indexOf('aria-label="Export data"')
	);
	assert.equal(activePendingDialog.includes('<button class="primary" disabled'), false);
	assert.equal(activePendingDialog.includes('Export pending changes</button>'), true);

	const snapshotPendingExport = renderPlannerHtml((planner) => {
		planner.pendingSync = false;
		planner.setPendingSyncSnapshot(planner.kitchen);
		planner.applyButler(
			[{ type: 'ui', action: 'export-pending' }],
			JSON.stringify(planner.kitchen)
		);
	});
	const snapshotPendingDialog = snapshotPendingExport.html.slice(
		snapshotPendingExport.html.indexOf('aria-label="Export data"')
	);
	assert.equal(snapshotPendingDialog.includes('<button class="primary" disabled'), false);
	assert.equal(snapshotPendingDialog.includes('Export pending changes</button>'), true);

	// 4. Undo-toast presence: mutation shows Undo button, navigation omits Undo button
	const mutationRender = renderPlannerHtml((planner) => {
		planner.applyButler(
			[
				{
					type: 'pantry.upsert',
					item: { id: 'p-salt', name: 'Kosher salt', quantity: 1, unit: 'box', category: 'Spices' }
				}
			],
			JSON.stringify(planner.kitchen)
		);
	});
	assert.equal(typeof mutationRender.api.toastUndo, 'function');
	assert.match(mutationRender.html, /Basil’s changes applied\./);
	assert.match(mutationRender.html, />Undo<\/button>/);

	const navRender = renderPlannerHtml((planner) => {
		planner.applyButler([{ type: 'navigate', page: 'shopping' }], JSON.stringify(planner.kitchen));
	});
	assert.equal(navRender.api.toastUndo, null);
	assert.match(navRender.html, /Opened in your kitchen\./);
	assert.doesNotMatch(navRender.html, />Undo<\/button>/);
});

test('applyButler gates sign-out and confirmPendingExport downloads and preserves create-mode recipe drafts on undo', async () => {
	const harness = createReactivePlanner();
	try {
		const { api, downloads } = harness;
		api.kitchen = {
			...dataMod.createNewUserState(),
			recipes: [makeRecipe('r-existing', 'Existing Soup')],
			shopping: [{ id: 'shop-milk', name: 'Milk', quantity: 2, unit: 'L', checked: false }]
		};
		api.user = {
			id: 'u-1',
			name: 'Alex',
			email: 'alex@example.test',
			householdId: 'h-1'
		};

		// Sign-out UI command opens confirmation modal without ending the session or offering Undo.
		api.applyButler([{ type: 'ui', action: 'sign-out' }], JSON.stringify(api.kitchen));
		assert.equal(api.modal, 'signOut');
		assert.equal(api.user?.id, 'u-1');
		assert.equal(api.toast, 'Confirm this action to continue.');
		assert.equal(api.toastUndo, null);
		api.closeDialog();
		assert.equal(api.modal, '');

		// Export shopping opens confirmation modal without downloading until confirmPendingExport runs.
		api.applyButler([{ type: 'ui', action: 'export-shopping' }], JSON.stringify(api.kitchen));
		assert.equal(api.modal, 'export');
		assert.equal(api.pendingExport, 'shopping');
		assert.equal(downloads.length, 0);
		await api.confirmPendingExport();
		assert.equal(api.modal, '');
		assert.equal(api.pendingExport, null);
		assert.equal(downloads.length, 1);
		assert.equal(downloads[0].filename, 'flavorithm-shopping.txt');
		assert.match(downloads[0].content, /☐ 2 L Milk/);

		// Export kitchen fetches /api/export only upon confirmation.
		api.applyButler([{ type: 'ui', action: 'export-kitchen' }], JSON.stringify(api.kitchen));
		assert.equal(api.modal, 'export');
		assert.equal(api.pendingExport, 'kitchen');
		assert.equal(downloads.length, 1);
		await api.confirmPendingExport();
		assert.equal(downloads.length, 2);
		assert.equal(downloads[1].filename, 'flavorithm-kitchen.json');
		assert.equal(JSON.parse(downloads[1].content).source, 'account');

		// Export pending downloads staged local state when present, and notifies when absent.
		api.setPendingSyncSnapshot(api.kitchen);
		api.applyButler([{ type: 'ui', action: 'export-pending' }], JSON.stringify(api.kitchen));
		await api.confirmPendingExport();
		assert.equal(downloads.length, 3);
		assert.equal(downloads[2].filename, 'flavorithm-kitchen.json');
		assert.equal(JSON.parse(downloads[2].content).hasPendingChanges, true);

		api.setPendingSyncSnapshot(null);
		api.pendingSync = false;
		api.pendingExport = 'pending';
		await api.confirmPendingExport();
		assert.equal(downloads.length, 3);
		assert.equal(api.toast, 'There are no pending changes to export.');

		// Open a create-mode recipe editor draft, edit its title, apply an unrelated Basil mutation, and undo.
		api.openNewRecipe();
		assert.equal(api.editingRecipeMode, 'create');
		assert.ok(api.editingRecipe);
		const draftId = api.editingRecipe.id;
		api.editingRecipe.title = 'My Unsaved Focaccia Draft';

		api.applyButler(
			[
				{
					type: 'pantry.upsert',
					item: {
						id: 'p-rosemary',
						name: 'Rosemary',
						quantity: 2,
						unit: 'sprigs',
						category: 'Produce'
					}
				}
			],
			JSON.stringify(api.kitchen)
		);
		assert.equal(api.kitchen.pantry.length, 1);
		assert.equal(api.toast, 'Basil’s changes applied.');
		assert.equal(typeof api.toastUndo, 'function');

		api.toastUndo!();
		assert.equal(api.kitchen.pantry.length, 0);
		assert.equal(api.editingRecipeMode, 'create');
		assert.equal(api.editingRecipe?.id, draftId);
		assert.equal(api.editingRecipe?.title, 'My Unsaved Focaccia Draft');

		// Conversely, undoing a compound recipe upsert + open closes the newly created recipe view.
		const createdRecipe = { ...makeRecipe('r-basil-new', 'Basil Risotto'), image: '' };
		api.applyButler(
			[
				{ type: 'recipe.upsert', recipe: createdRecipe },
				{ type: 'recipe.open', id: createdRecipe.id, mode: 'edit' }
			],
			JSON.stringify(api.kitchen)
		);
		assert.equal(api.editingRecipeMode, 'edit');
		assert.equal(api.editingRecipe?.id, createdRecipe.id);
		assert.equal(typeof api.toastUndo, 'function');

		api.toastUndo!();
		assert.equal(
			api.kitchen.recipes.some((item) => item.id === createdRecipe.id),
			false
		);
		assert.equal(api.editingRecipe, null);

		// Verify createButlerChat + askButler controller integration preserves droppedCommands warnings,
		// frozen details, and split [User applied]/[User opened] paired history.
		api.kitchen.preferences.usePersonalAI = true;
		api.kitchen.preferences.provider = 'openai';
		api.kitchen.preferences.model = 'gpt-4.1-mini';
		api.setApiKey('sk-test-key');

		let chatDraft = '';
		let chatMessages: butlerChatMod.ButlerChatMessage[] = [];
		let chatDrafts: Recipe[] = [];
		let chatBusy = false;
		let chatError = '';
		let chatFailedPrompt = '';
		const controller = butlerChatMod.createButlerChat({
			getKitchen: () => JSON.parse(JSON.stringify(api.kitchen)) as AppState,
			getOwner: () => `${api.user?.id ?? ''}:${api.user?.householdId ?? ''}`,
			isWorking: () => chatBusy,
			getDraft: () => chatDraft,
			setDraft: (value) => {
				chatDraft = value;
			},
			getMessages: () => chatMessages,
			setMessages: (value) => {
				chatMessages = value;
			},
			getRecipeDrafts: () => chatDrafts,
			setRecipeDrafts: (value) => {
				chatDrafts = value;
			},
			setBusy: (value) => {
				chatBusy = value;
			},
			setError: (value) => {
				chatError = value;
			},
			getFailedPrompt: () => chatFailedPrompt,
			setFailedPrompt: (value) => {
				chatFailedPrompt = value;
			},
			request: (prompt, history, signal, recipeDrafts) =>
				api.askButler(prompt, history, signal, recipeDrafts)
		});

		harness.setAiResponse({
			reply: 'Added thyme and prepared your shopping export.',
			commands: [
				{
					type: 'pantry.upsert',
					item: { id: 'p-thyme', name: 'Thyme', quantity: 1, unit: 'bunch', category: 'Produce' }
				},
				{ type: 'ui', action: 'export-shopping' }
			],
			droppedCommands: 1
		});
		chatDraft = 'Add thyme and export shopping';
		await controller.send();
		assert.equal(chatError, '');
		assert.equal(chatMessages.length, 2);
		assert.equal(chatMessages[1].warning, '1 invalid action was omitted from this reply.');
		assert.equal(chatMessages[1].actions?.length, 2);

		const firstCard = chatMessages[1].actions![0];
		const secondCard = chatMessages[1].actions![1];
		chatMessages[1].snapshot = api.applyButler(firstCard.commands, chatMessages[1].snapshot!);
		firstCard.status = 'applied';
		chatMessages[1].snapshot = api.applyButler(secondCard.commands, chatMessages[1].snapshot!);
		secondCard.status = 'applied';
		api.closeDialog();

		harness.setAiResponse({ reply: 'All set.', commands: [] });
		chatDraft = 'Follow up';
		await controller.send();
		const secondPayload = harness.aiRequests.at(-1) as {
			messages: butlerChatMod.ButlerTurn[];
		};
		assert.deepEqual(secondPayload.messages, [
			{ role: 'user', content: 'Add thyme and export shopping' },
			{
				role: 'assistant',
				content:
					'Added thyme and prepared your shopping export.\n\n[User applied: Thyme]\n[User opened: Export shopping list]'
			},
			{ role: 'user', content: 'Follow up' }
		]);
		controller.destroy();
	} finally {
		harness.dispose();
	}
});

test('+page.svelte exportKitchen commits inline edits, merges account state, and distinguishes 401 expiry and offline modes', async () => {
	let fetchCalls = 0;
	const harness = createReactivePlanner({
		fetch: (async () => {
			fetchCalls += 1;
			throw new Error('Guest export must not call fetch');
		}) as typeof fetch
	});

	try {
		const { api, downloads, navigatorState, setFetch } = harness;

		// 1. Guest export: zero network calls, source='guest', guest toast.
		api.user = null;
		const guestState = dataMod.createInitialState();
		guestState.pantry = [
			{ id: 'mint', name: 'Mint', quantity: 1, unit: 'bunch', category: 'Produce' }
		];
		api.kitchen = guestState;
		await api.exportKitchen();

		assert.equal(fetchCalls, 0);
		assert.equal(downloads.length, 1);
		assert.equal(downloads[0].filename, 'flavorithm-kitchen.json');
		const guestEnvelope = JSON.parse(downloads[0].content);
		assert.equal(guestEnvelope.source, 'guest');
		assert.equal(guestEnvelope.hasPendingChanges, false);
		assert.equal(guestEnvelope.state.pantry[0]?.id, 'mint');
		assert.match(api.toast, /guest kitchen data exported/i);

		// 2. Signed-in online export with uncommitted inline pantry draft: commits draft, stages, merges with /api/export.
		const signedInUser: User = {
			id: 'page-cook',
			name: 'Page Cook',
			email: 'page@example.test',
			householdId: 'page-home'
		};
		const baseline = dataMod.createNewUserState();
		baseline.pantry = [
			{ id: 'beans', name: 'Black beans', quantity: 2, unit: 'can', category: 'Canned goods' }
		];
		api.user = signedInUser;
		api.online = true;
		navigatorState.onLine = true;
		api.kitchenLoaded = true;
		api.initKitchenSyncForTest(signedInUser, baseline, 'etag-page-1');
		api.ready = true;

		await api.startPantryEdit(api.kitchen.pantry[0]);
		api.setPantryDraftQuantity('9');

		const serverState = structuredClone(baseline);
		serverState.shopping = [
			{ id: 'cilantro', name: 'Cilantro', quantity: 1, unit: 'bunch', checked: false }
		];
		let exportCalls = 0;
		setFetch((async (input, init) => {
			if (input !== '/api/export') {
				return Response.json({ ok: true });
			}
			exportCalls += 1;
			assert.equal(init?.redirect, 'manual');
			return Response.json({
				exportedAt: '2026-11-24T18:00:00.000Z',
				user: { ...signedInUser, emailVerified: true },
				state: serverState
			});
		}) as typeof fetch);

		await api.exportKitchen();
		assert.equal(exportCalls, 1);
		assert.equal(downloads.length, 2);
		const accountEnvelope = JSON.parse(downloads[1].content);
		assert.equal(accountEnvelope.source, 'account');
		assert.equal(accountEnvelope.hasPendingChanges, true);
		assert.equal(accountEnvelope.state.pantry[0]?.quantity, 9);
		assert.equal(accountEnvelope.state.shopping[0]?.id, 'cilantro');
		assert.match(api.toast, /merged account and kitchen data exported/i);

		// 3. Expired session (401) while online via exportPendingChanges: no retry, distinct session-expired toast.
		let auth401Calls = 0;
		setFetch((async () => {
			auth401Calls += 1;
			return Response.json({ error: 'Authentication required' }, { status: 401 });
		}) as typeof fetch);

		api.exportPendingChanges();
		// Wait for async exportKitchen triggered by exportPendingChanges.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(auth401Calls, 1);
		assert.equal(downloads.length, 3);
		const expiredEnvelope = JSON.parse(downloads[2].content);
		assert.equal(expiredEnvelope.source, 'offline');
		assert.match(api.toast, /session expired/i);
		assert.doesNotMatch(api.toast, /offline device kitchen data/i);

		// 4. Slow/timed-out /api/export retries once and shows distinct timeout toast on fallback.
		let timeoutAttempts = 0;
		setFetch((async (input) => {
			if (input !== '/api/export') return Response.json({ ok: true });
			timeoutAttempts += 1;
			throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
		}) as typeof fetch);

		await api.exportKitchen();
		assert.equal(timeoutAttempts, 2);
		assert.equal(downloads.length, 4);
		assert.equal(JSON.parse(downloads[3].content).source, 'offline');
		assert.match(api.toast, /took too long/i);

		// 5. Offline mode skips network calls and shows offline backup toast.
		navigatorState.onLine = false;
		let offlineCalls = 0;
		setFetch((async () => {
			offlineCalls += 1;
			throw new Error('Offline mode must not call fetch');
		}) as typeof fetch);

		await api.exportKitchen();
		assert.equal(offlineCalls, 0);
		assert.equal(downloads.length, 5);
		assert.equal(JSON.parse(downloads[4].content).source, 'offline');
		assert.match(api.toast, /offline device kitchen data/i);
	} finally {
		harness.dispose();
	}
});
