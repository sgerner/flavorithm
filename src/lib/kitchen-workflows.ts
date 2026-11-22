import type { AppState, Ingredient, Meal, Recipe, ShoppingItem } from './types';
import { buildShoppingList, normalizeName, unitInfo } from './domain.ts';
import { isValidServings, MAX_SHOPPING_QUANTITY } from './recipe-draft.ts';
export { normalizeName, normalizeName as normalizeIngredientName, unitInfo } from './domain.ts';

/** Convert a quantity when both units are in the same dimension, otherwise return undefined. */
export function convertCompatibleQuantity(
	quantity: number,
	fromUnit: string,
	toUnit: string
): number | undefined {
	if (!Number.isFinite(quantity)) return undefined;
	const from = unitInfo(fromUnit);
	const to = unitInfo(toUnit);
	if (from.dimension !== to.dimension) return undefined;
	return (quantity * from.factor) / to.factor;
}

function roundQuantity(value: number): number {
	const rounded = Math.round(value * 100) / 100;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function roundPantryQuantity(value: number): number {
	const rounded = Math.round(value * 1_000_000) / 1_000_000;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function bucketKey(name: string, unit: string): string {
	return `${normalizeName(name)}\u0000${unitInfo(unit).dimension}`;
}

function stableHash(value: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(36);
}

function generatedShoppingId(sourceKey: string, key: string): string {
	return `generated-${stableHash(`${sourceKey}\u0000${key}`)}`;
}

function nextFreeGeneratedId(sourceKey: string, key: string, usedIds: Set<string>): string {
	const baseId = generatedShoppingId(sourceKey, key);
	let candidate = baseId;
	let suffix = 2;
	while (usedIds.has(candidate)) candidate = `${baseId}-${suffix++}`;
	usedIds.add(candidate);
	return candidate;
}

export type ExpiryStatus = 'expired' | 'soon' | 'fresh' | 'unknown';

function calendarDate(value: Date): { year: number; month: number; day: number } | undefined {
	if (!Number.isFinite(value.getTime())) return undefined;
	return { year: value.getFullYear(), month: value.getMonth(), day: value.getDate() };
}

function expiryDate(value: string): { year: number; month: number; day: number } | undefined {
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (dateOnly) {
		const year = Number(dateOnly[1]);
		const month = Number(dateOnly[2]) - 1;
		const day = Number(dateOnly[3]);
		const parsed = new Date(0);
		parsed.setFullYear(year, month, day);
		parsed.setHours(0, 0, 0, 0);
		if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day)
			return undefined;
		return { year, month, day };
	}

	const parsed = new Date(value);
	return calendarDate(parsed);
}

function dateOrdinal(date: { year: number; month: number; day: number }): number {
	const utcDate = new Date(0);
	utcDate.setUTCFullYear(date.year, date.month, date.day);
	utcDate.setUTCHours(0, 0, 0, 0);
	return Math.floor(utcDate.getTime() / 86_400_000);
}

/** Classify an expiry by local calendar day; date-only strings are never parsed as UTC. */
export function expiryStatus(expires?: string, now: Date = new Date()): ExpiryStatus {
	if (!expires?.trim()) return 'unknown';
	const expiry = expiryDate(expires);
	const today = calendarDate(now);
	if (!expiry || !today) return 'unknown';
	const daysUntilExpiry = dateOrdinal(expiry) - dateOrdinal(today);
	if (daysUntilExpiry < 0) return 'expired';
	if (daysUntilExpiry <= 3) return 'soon';
	return 'fresh';
}

/**
 * Replace one generated shopping-list scope while retaining manual entries, other scopes,
 * and checked purchases. Checked purchases reduce matching quantities in the refreshed list.
 */
export function reconcileShoppingList(
	existing: ShoppingItem[],
	additions: ShoppingItem[],
	sourceKey: string
): ShoppingItem[] {
	const checked = existing.filter((item) => item.sourceKey === sourceKey && item.checked);
	const checkedByBucket = new Map<string, number>();
	for (const item of checked) {
		if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
		const key = bucketKey(item.name, item.unit);
		const unit = unitInfo(item.unit);
		checkedByBucket.set(key, (checkedByBucket.get(key) ?? 0) + item.quantity * unit.factor);
	}
	const existingUncheckedIds = new Map<string, string>();
	for (const item of existing) {
		if (item.sourceKey !== sourceKey || item.checked) continue;
		const key = bucketKey(item.name, item.unit);
		if (!existingUncheckedIds.has(key)) existingUncheckedIds.set(key, item.id);
	}

	const retained = existing.filter((item) => item.sourceKey !== sourceKey || item.checked);
	const usedIds = new Set(retained.map((item) => item.id));
	const additionBuckets = new Map<
		string,
		{ item: ShoppingItem; unit: ReturnType<typeof unitInfo>; quantityBase: number }
	>();
	for (const addition of additions) {
		if (!Number.isFinite(addition.quantity) || addition.quantity <= 0) continue;
		const key = bucketKey(addition.name, addition.unit);
		const unit = unitInfo(addition.unit);
		const bucket = additionBuckets.get(key) ?? { item: addition, unit, quantityBase: 0 };
		bucket.quantityBase += addition.quantity * unit.factor;
		additionBuckets.set(key, bucket);
	}

	const generated: ShoppingItem[] = [];
	for (const [key, bucket] of additionBuckets) {
		const alreadyPurchased = checkedByBucket.get(key) ?? 0;
		const remainingBase = Math.max(0, bucket.quantityBase - alreadyPurchased);
		const remainingQuantity = Math.min(
			MAX_SHOPPING_QUANTITY,
			roundQuantity(remainingBase / bucket.unit.factor)
		);
		if (remainingQuantity <= 0) continue;
		const reusableId = existingUncheckedIds.get(key);
		let id: string;
		if (reusableId && !usedIds.has(reusableId)) {
			id = reusableId;
			usedIds.add(id);
		} else {
			id = nextFreeGeneratedId(sourceKey, key, usedIds);
		}
		generated.push({
			...bucket.item,
			id,
			quantity: remainingQuantity,
			unit: bucket.unit.display,
			checked: false,
			sourceKey
		});
	}

	return [...retained, ...generated];
}

/** Move checked purchases into pantry stock, merging aliases and compatible units safely. */
export function transferPurchasedItemsToPantry(
	pantry: Ingredient[],
	purchases: ShoppingItem[],
	createId: () => string = () => globalThis.crypto.randomUUID()
): Ingredient[] {
	const result = pantry.map((item) => ({ ...item }));
	const buckets = new Map<
		string,
		{ name: string; unit: ReturnType<typeof unitInfo>; quantityBase: number }
	>();
	for (const item of purchases) {
		if (
			!item.checked ||
			!Number.isFinite(item.quantity) ||
			!(item.quantity > 0) ||
			!item.unit.trim()
		)
			continue;
		const normalizedName = normalizeName(item.name);
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const bucket = buckets.get(key) ?? { name: item.name.trim(), unit, quantityBase: 0 };
		bucket.quantityBase += item.quantity * unit.factor;
		buckets.set(key, bucket);
	}

	const usedIds = new Set(result.map((item) => item.id));
	for (const [key, bucket] of buckets) {
		const [normalizedName] = key.split('\u0000');
		const destination = result.find(
			(item) =>
				normalizeName(item.name) === normalizedName &&
				unitInfo(item.unit).dimension === bucket.unit.dimension &&
				!item.expires?.trim()
		);
		if (destination) {
			destination.quantity = roundPantryQuantity(
				destination.quantity + bucket.quantityBase / unitInfo(destination.unit).factor
			);
			continue;
		}

		const baseId = createId();
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
		usedIds.add(id);
		result.push({
			id,
			name: bucket.name,
			quantity: roundPantryQuantity(bucket.quantityBase / bucket.unit.factor),
			unit: bucket.unit.display,
			category: 'Pantry'
		});
	}
	return result;
}

function recipeForMeal(state: AppState, meal: Meal): Recipe | undefined {
	return state.recipes.find((recipe) => recipe.id === meal.recipeId);
}

function expiryPriority(expires: string | undefined, now: Date): number {
	const expiry = expires ? expiryDate(expires) : undefined;
	const today = calendarDate(now);
	if (!expiry || !today) return Number.MAX_SAFE_INTEGER;
	return dateOrdinal(expiry) - dateOrdinal(today);
}

function consumePantry(
	pantry: Ingredient[],
	recipe: Recipe,
	servings: number,
	now: Date
): Ingredient[] {
	const remaining = pantry.map((item) => ({ ...item }));
	const scale = recipe.servings > 0 && servings > 0 ? servings / recipe.servings : 1;

	for (const ingredient of recipe.ingredients) {
		if (
			!Number.isFinite(ingredient.quantity) ||
			ingredient.quantity <= 0 ||
			!ingredient.unit.trim()
		)
			continue;
		let need = ingredient.quantity * scale;
		const candidates = remaining
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => normalizeName(item.name) === normalizeName(ingredient.name))
			.filter(({ item }) => expiryStatus(item.expires, now) !== 'expired')
			.sort(
				(a, b) =>
					expiryPriority(a.item.expires, now) - expiryPriority(b.item.expires, now) ||
					a.index - b.index
			);

		for (const { item, index } of candidates) {
			if (need <= 0) break;
			const available = convertCompatibleQuantity(item.quantity, item.unit, ingredient.unit);
			if (available === undefined || !(available > 0)) continue;
			const used = Math.min(need, available);
			const remainingInRecipeUnit = available - used;
			const remainingInPantryUnit = convertCompatibleQuantity(
				remainingInRecipeUnit,
				ingredient.unit,
				item.unit
			);
			if (remainingInPantryUnit !== undefined)
				remaining[index] = {
					...item,
					quantity: roundPantryQuantity(Math.max(0, remainingInPantryUnit))
				};
			need = Math.max(0, need - used);
		}
	}

	return remaining;
}

/** Mark a planned meal complete and optionally deduct its ingredient quantities from pantry. */
export function completeMeal(
	state: AppState,
	mealId: string,
	options: { deductPantry: boolean; leftoverServings: number },
	now: Date = new Date()
): AppState {
	const target = state.meals.find((meal) => meal.id === mealId);
	if (!target || target.completedAt) return state;

	const recipe = recipeForMeal(state, target);
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const servingsLimit = Number.isFinite(target.servings) ? Math.max(0, target.servings) : 0;
	const leftoverServings = Number.isFinite(options.leftoverServings)
		? roundQuantity(Math.min(servingsLimit, Math.max(0, options.leftoverServings)))
		: 0;
	const meals = state.meals.map((meal) =>
		meal.id === mealId ? { ...meal, completedAt: safeNow.toISOString(), leftoverServings } : meal
	);
	const pantry =
		options.deductPantry && recipe
			? consumePantry(state.pantry, recipe, target.servings, safeNow)
			: state.pantry;

	return { ...state, meals, pantry };
}

function formatCalendarKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function weekStartForDate(value: string): string {
	const date = new Date(`${value}T12:00:00`);
	if (Number.isNaN(date.getTime())) return value;
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return formatCalendarKey(date);
}

export function refreshWeekShoppingInState(state: AppState, startDate: string): ShoppingItem[] {
	const start = new Date(`${startDate}T12:00:00`);
	if (Number.isNaN(start.getTime())) return state.shopping;
	const dates = Array.from({ length: 7 }, (_, index) => {
		const day = new Date(start);
		day.setDate(day.getDate() + index);
		return formatCalendarKey(day);
	});
	const meals = state.meals.filter((meal) => dates.includes(meal.date) && !meal.completedAt);
	const recipes = state.recipes.filter((recipe) =>
		meals.some((meal) => meal.recipeId === recipe.id)
	);
	const additions = buildShoppingList(recipes, state.pantry, meals);
	return reconcileShoppingList(state.shopping, additions, `week:${startDate}`);
}

export function schedulePlannedMeal(
	state: AppState,
	input: {
		id?: string;
		recipeId: string | null | undefined;
		date: string;
		slot: string;
		servings: number;
	}
):
	| { status: 'scheduled'; state: AppState; meal: Meal }
	| { status: 'missing-recipe'; state: AppState }
	| { status: 'invalid-date'; state: AppState }
	| { status: 'invalid-servings'; state: AppState } {
	if (!input.date) return { status: 'invalid-date', state };
	const recipe = input.recipeId
		? state.recipes.find((item) => item.id === input.recipeId)
		: undefined;
	if (!recipe) return { status: 'missing-recipe', state };
	if (!isValidServings(input.servings)) {
		return { status: 'invalid-servings', state };
	}
	const meal: Meal = {
		id: input.id ?? globalThis.crypto.randomUUID(),
		date: input.date,
		slot: input.slot,
		recipeId: recipe.id,
		servings: input.servings
	};
	const nextMeals = [...state.meals, meal];
	const nextWithMeals = { ...state, meals: nextMeals };
	const shopping = refreshWeekShoppingInState(nextWithMeals, weekStartForDate(input.date));
	return { status: 'scheduled', state: { ...nextWithMeals, shopping }, meal };
}

export function savePlannedMealChanges(
	state: AppState,
	input: {
		mealId: string;
		date: string;
		slot: string;
		servings: number;
	}
):
	| { status: 'updated'; state: AppState }
	| { status: 'missing'; state: AppState }
	| { status: 'completed'; state: AppState }
	| { status: 'invalid-slot'; state: AppState }
	| { status: 'invalid-servings'; state: AppState } {
	const meal = state.meals.find((item) => item.id === input.mealId);
	if (!meal) return { status: 'missing', state };
	if (meal.completedAt) return { status: 'completed', state };
	if (!input.date || !['Breakfast', 'Lunch', 'Dinner'].includes(input.slot)) {
		return { status: 'invalid-slot', state };
	}
	if (!isValidServings(input.servings)) {
		return { status: 'invalid-servings', state };
	}
	const previousWeek = weekStartForDate(meal.date);
	const nextWeek = weekStartForDate(input.date);
	const meals = state.meals.map((item) =>
		item.id === input.mealId
			? { ...item, date: input.date, slot: input.slot, servings: Math.round(input.servings) }
			: item
	);
	let nextState: AppState = { ...state, meals };
	for (const weekStart of new Set([previousWeek, nextWeek])) {
		nextState = { ...nextState, shopping: refreshWeekShoppingInState(nextState, weekStart) };
	}
	return { status: 'updated', state: nextState };
}

export function cookPlannedMeal(
	state: AppState,
	input: {
		mealId: string;
		deductPantry: boolean;
		leftoverServings: number;
	},
	now: Date = new Date()
):
	| { status: 'cooked'; state: AppState; meal: Meal; recipe: Recipe | undefined }
	| { status: 'missing'; state: AppState }
	| { status: 'completed'; state: AppState }
	| { status: 'invalid-leftovers'; state: AppState; meal: Meal } {
	const meal = state.meals.find((item) => item.id === input.mealId);
	if (!meal) return { status: 'missing', state };
	if (meal.completedAt) return { status: 'completed', state };
	if (
		!Number.isInteger(input.leftoverServings) ||
		input.leftoverServings < 0 ||
		input.leftoverServings > meal.servings
	) {
		return { status: 'invalid-leftovers', state, meal };
	}
	const completed = completeMeal(
		state,
		meal.id,
		{
			deductPantry: input.deductPantry,
			leftoverServings: Math.round(input.leftoverServings)
		},
		now
	);
	const shopping = refreshWeekShoppingInState(completed, weekStartForDate(meal.date));
	const recipe = completed.recipes.find((item) => item.id === meal.recipeId);
	return { status: 'cooked', state: { ...completed, shopping }, meal, recipe };
}
