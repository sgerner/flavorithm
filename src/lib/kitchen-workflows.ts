import type { AppState, Ingredient, Meal, Recipe, ShoppingItem } from './types';
import { buildShoppingList, normalizeName, unitInfo } from './domain.ts';
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
		const remainingQuantity = roundQuantity(remainingBase / bucket.unit.factor);
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

function parseCalendarKey(value: string): { year: number; month: number; day: number } | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]) - 1;
	const day = Number(match[3]);
	const parsed = new Date(0);
	parsed.setFullYear(year, month, day);
	parsed.setHours(0, 0, 0, 0);
	if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day)
		return undefined;
	return { year, month, day };
}

function formatCalendarDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localNoonDate(parts: { year: number; month: number; day: number }): Date {
	const date = new Date(0);
	date.setFullYear(parts.year, parts.month, parts.day);
	date.setHours(12, 0, 0, 0);
	return date;
}

function weekWindowDates(startDate: string): Set<string> | undefined {
	const parsed = parseCalendarKey(startDate);
	if (!parsed) return undefined;
	const start = localNoonDate(parsed);
	return new Set(
		Array.from({ length: 7 }, (_, index) => {
			const day = new Date(start);
			day.setDate(start.getDate() + index);
			return formatCalendarDate(day);
		})
	);
}

/** Return the Monday YYYY-MM-DD calendar key for a local date string or Date instance. */
export function weekStartForDate(value: string | Date): string {
	if (typeof value === 'string') {
		const parsed = parseCalendarKey(value);
		if (!parsed) return value;
		const day = localNoonDate(parsed);
		day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
		return formatCalendarDate(day);
	}
	const parts = calendarDate(value);
	if (!parts) return '';
	const day = localNoonDate(parts);
	day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
	return formatCalendarDate(day);
}

function existingShoppingWeeks(shopping: ShoppingItem[]): string[] {
	return [
		...new Set(
			shopping.flatMap((item) => {
				const week = item.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1];
				return week && parseCalendarKey(week) ? [week] : [];
			})
		)
	];
}

function affectedWeekStarts(shopping: ShoppingItem[], dates: Iterable<string>): string[] {
	const targetDates = [...new Set([...dates].filter((date) => Boolean(parseCalendarKey(date))))];
	const weeks = new Set<string>();
	for (const date of targetDates) {
		const start = weekStartForDate(date);
		if (parseCalendarKey(start)) weeks.add(start);
	}
	for (const existingWeek of existingShoppingWeeks(shopping)) {
		const window = weekWindowDates(existingWeek);
		if (window && targetDates.some((date) => window.has(date))) weeks.add(existingWeek);
	}
	return [...weeks];
}

/** Refresh one weekly shopping-list scope from incomplete planned meals in that 7-day window. */
export function refreshWeekShopping(
	state: AppState,
	startDate: string,
	now: Date = new Date()
): AppState {
	const dates = weekWindowDates(startDate);
	if (!dates) return state;
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const meals = state.meals.filter((meal) => !meal.completedAt && dates.has(meal.date));
	const additions = buildShoppingList(state.recipes, state.pantry, meals, safeNow);
	const shopping = reconcileShoppingList(state.shopping, additions, `week:${startDate}`);
	return { ...state, shopping };
}

function refreshWeeks(state: AppState, weekStarts: Iterable<string>, now: Date): AppState {
	let next = state;
	for (const startDate of new Set(weekStarts)) {
		next = refreshWeekShopping(next, startDate, now);
	}
	return next;
}

/**
 * Refresh a single-recipe shopping scope when that recipe already has generated items in the list,
 * scaling from the recipe's current servings baseline while preserving manual and checked rows.
 */
export function refreshRecipeShopping(
	state: AppState,
	recipeId: string,
	now: Date = new Date()
): AppState {
	const sourceKey = `recipe:${recipeId}`;
	if (!state.shopping.some((item) => item.sourceKey === sourceKey)) return state;
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const target = state.recipes.find((recipe) => recipe.id === recipeId);
	const additions = target ? buildShoppingList([target], state.pantry, undefined, safeNow) : [];
	const shopping = reconcileShoppingList(state.shopping, additions, sourceKey);
	return { ...state, shopping };
}

function cloneRecipe(recipe: Recipe): Recipe {
	return {
		...recipe,
		tags: [...recipe.tags],
		ingredients: recipe.ingredients.map((item) => ({ ...item })),
		steps: [...recipe.steps],
		nutrition: { ...recipe.nutrition },
		...(recipe.importNotes ? { importNotes: [...recipe.importNotes] } : {})
	};
}

/** Return true when servings or ingredient entries changed compared to the previous recipe. */
export function recipeNeedsNutritionRefresh(
	previous: Recipe | undefined,
	updated: Recipe
): boolean {
	if (!previous) return false;
	if (previous.servings !== updated.servings) return true;
	if (previous.ingredients.length !== updated.ingredients.length) return true;
	return previous.ingredients.some((item, index) => {
		const next = updated.ingredients[index];
		return item.name !== next.name || item.quantity !== next.quantity || item.unit !== next.unit;
	});
}

/** Clone a saved or unsaved recipe from state for manual editing. */
export function recipeForEdit(state: AppState, recipeId: string): Recipe | null {
	const target = state.recipes.find((recipe) => recipe.id === recipeId);
	return target ? cloneRecipe(target) : null;
}

/**
 * Insert or update a recipe, track nutrition staleness and ratings, and refresh affected weekly
 * and existing single-recipe shopping scopes.
 */
export function upsertRecipe(state: AppState, recipe: Recipe, now: Date = new Date()): AppState {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const previous = state.recipes.find((item) => item.id === recipe.id);
	const updated = cloneRecipe(recipe);
	if (recipeNeedsNutritionRefresh(previous, updated) || previous?.nutritionStale) {
		updated.nutritionStale = true;
	}
	const recipes = previous
		? state.recipes.map((item) => (item.id === updated.id ? updated : item))
		: [...state.recipes, updated];
	const preferences =
		updated.rating !== undefined
			? {
					...state.preferences,
					ratings: {
						...state.preferences.ratings,
						[updated.id]: updated.rating
					}
				}
			: state.preferences;

	let next: AppState = { ...state, recipes, preferences };
	const plannedMealDates = next.meals
		.filter((meal) => !meal.completedAt && meal.recipeId === updated.id)
		.map((meal) => meal.date);
	next = refreshWeeks(next, affectedWeekStarts(next.shopping, plannedMealDates), safeNow);
	next = refreshRecipeShopping(next, updated.id, safeNow);
	return next;
}

/** Save an edited recipe (whether previously saved or unsaved) into the recipe collection. */
export function saveEditedRecipe(
	state: AppState,
	updated: Recipe,
	now: Date = new Date()
): AppState {
	return upsertRecipe(state, { ...updated, saved: true }, now);
}

/** Delete a recipe, its scheduled/completed meals, rating, and recipe shopping scope, then refresh weeks. */
export function deleteRecipe(state: AppState, recipeId: string, now: Date = new Date()): AppState {
	if (!state.recipes.some((recipe) => recipe.id === recipeId)) return state;
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const impactedMeals = state.meals.filter((meal) => meal.recipeId === recipeId);
	const weeksToRefresh = affectedWeekStarts(
		state.shopping,
		impactedMeals.map((meal) => meal.date)
	);
	const recipes = state.recipes.filter((recipe) => recipe.id !== recipeId);
	const meals = state.meals.filter((meal) => meal.recipeId !== recipeId);
	const shopping = state.shopping.filter((item) => item.sourceKey !== `recipe:${recipeId}`);
	let preferences = state.preferences;
	if (state.preferences.ratings && recipeId in state.preferences.ratings) {
		const ratings = { ...state.preferences.ratings };
		delete ratings[recipeId];
		preferences = { ...state.preferences, ratings };
	}
	return refreshWeeks({ ...state, recipes, meals, shopping, preferences }, weeksToRefresh, safeNow);
}

/** Add or update a meal (preserving completion metadata) and refresh both previous and target weeks. */
export function upsertMeal(state: AppState, meal: Meal, now: Date = new Date()): AppState {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const previous = state.meals.find((item) => item.id === meal.id);
	const nextMeal: Meal = previous?.completedAt
		? {
				...meal,
				completedAt: previous.completedAt,
				leftoverServings: previous.leftoverServings
			}
		: { ...meal };
	const meals = previous
		? state.meals.map((item) => (item.id === nextMeal.id ? nextMeal : item))
		: [...state.meals, nextMeal];
	const dates = previous ? [previous.date, nextMeal.date] : [nextMeal.date];
	const weeksToRefresh = affectedWeekStarts(state.shopping, dates);
	return refreshWeeks({ ...state, meals }, weeksToRefresh, safeNow);
}

/** Remove a planned or completed meal and refresh its weekly shopping scope. */
export function deleteMeal(state: AppState, mealId: string, now: Date = new Date()): AppState {
	const removed = state.meals.find((meal) => meal.id === mealId);
	if (!removed) return state;
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const meals = state.meals.filter((meal) => meal.id !== mealId);
	const weeksToRefresh = affectedWeekStarts(state.shopping, [removed.date]);
	return refreshWeeks({ ...state, meals }, weeksToRefresh, safeNow);
}

/** Mark a planned meal complete, optionally deduct pantry stock, and refresh affected shopping weeks. */
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
	const deductedPantry = Boolean(options.deductPantry && recipe);
	const pantry =
		deductedPantry && recipe
			? consumePantry(state.pantry, recipe, target.servings, safeNow)
			: state.pantry;
	const weeksToRefresh = [
		...affectedWeekStarts(state.shopping, [target.date]),
		...(deductedPantry ? existingShoppingWeeks(state.shopping) : [])
	];

	return refreshWeeks({ ...state, meals, pantry }, weeksToRefresh, safeNow);
}
