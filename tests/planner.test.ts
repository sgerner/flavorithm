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
import * as butlerMod from '../src/lib/butler.ts';
import * as syncMod from '../src/lib/client-sync.ts';
import * as dataMod from '../src/lib/data.ts';
import * as discoveryMod from '../src/lib/discovery.ts';
import * as domainMod from '../src/lib/domain.ts';
import * as guestMod from '../src/lib/guest-storage.ts';
import * as workflowsMod from '../src/lib/kitchen-workflows.ts';
import * as recipeDraftMod from '../src/lib/recipe-draft.ts';
import { MAX_RECIPES, insertRecipes } from '../src/lib/recipe-collection.ts';
import * as coverMod from '../src/lib/recipe-cover.ts';
import type { AppState, Meal, Recipe, User } from '../src/lib/types.ts';
import * as voiceConfigMod from '../src/lib/voice-config.ts';

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
		logout,
		deleteAccount
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
	readonly deductPantry: boolean;
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
	showMoreHistory: () => void;
	editPlannedMeal: (meal: Meal) => void;
	saveMealChanges: () => void;
	setPlannedDraft: (date: string, slot: string, servings: number) => void;
	useLeftovers: (meal: Meal) => void;
	rateRecipe: (recipe: Recipe, rating: number) => void;
	logout: () => Promise<void>;
	deleteAccount: (event: SubmitEvent) => Promise<void>;
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
		'#lib/recipe-cover.ts': coverMod,
		'#lib/focus.ts': { focusTrap: () => ({}) },
		'#lib/motion.ts': {
			backdropMotion: () => ({}),
			dialogMotion: () => ({}),
			revealMotion: () => ({}),
			fadeMotion: () => ({}),
			motionDuration: () => 0
		},
		'#lib/data.ts': dataMod,
		'#lib/domain.ts': domainMod,
		'#lib/kitchen-workflows.ts': workflowsMod,
		'#lib/recipe-draft.ts': recipeDraftMod,
		'#lib/discovery.ts': discoveryMod,
		'#lib/recipe-collection.ts': { insertRecipes },
		'#lib/butler.ts': butlerMod,
		'#lib/voice-capture.ts': { VoiceCapture: class {} },
		'#lib/voice-config.ts': voiceConfigMod,
		'#lib/guest-storage.ts': guestMod,
		'#lib/client-sync.ts': syncMod,
		'#lib/components/RecipeDetail.svelte': { default: noopComponent },
		'#lib/components/ButlerChat.svelte': { default: noopComponent },
		'#lib/components/RecipeEditor.svelte': { default: noopComponent },
		'#lib/components/SyncStatus.svelte': { default: noopComponent },
		'#lib/components/AIConnection.svelte': { default: noopComponent },
		'#lib/components/VoiceSettings.svelte': { default: noopComponent },
		'#lib/components/RecipeImport.svelte': {
			default: noopComponent,
			emptyImportSession: () => ({
				text: '',
				photo: '',
				photoName: '',
				draft: null,
				assumptions: []
			})
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

function createReactivePlanner() {
	const modMap = createModuleMap();
	const exports: { default?: any } = {};
	let api!: PlannerHarnessApi;
	const assignedUrls: string[] = [];
	const storage = makeMemoryStorage();
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
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
		localStorage: storage,
		navigator: { onLine: true },
		window: {
			location: {
				assign: (url: string) => assignedUrls.push(url),
				reload: () => {}
			},
			scrollTo: () => {}
		},
		fetch: async () =>
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	};
	sandbox.globalThis = sandbox;
	sandbox.__onPlannerInit = (instance: PlannerHarnessApi) => {
		api = instance;
	};
	runInNewContext(clientScriptJs, sandbox);
	const dispose = svelteClient.effect_root(() => {
		exports.default(null, { data: { authMode: 'local', loginUrl: null, logoutUrl: null } });
	});
	return { api, assignedUrls, storage, dispose };
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

test('marking a meal cooked keeps pantry deduction opt-in', () => {
	const harness = createReactivePlanner();
	try {
		const { api } = harness;
		const recipe = makeRecipe('r-cook', 'Weeknight Pasta');
		const meal: Meal = {
			id: 'meal-cook',
			date: '2026-11-23',
			slot: 'Dinner',
			recipeId: recipe.id,
			servings: recipe.servings
		};
		api.kitchen = { ...dataMod.createNewUserState(), recipes: [recipe], meals: [meal] };

		api.openCookDialog(meal);

		assert.equal(api.deductPantry, false);
	} finally {
		harness.dispose();
	}
});
