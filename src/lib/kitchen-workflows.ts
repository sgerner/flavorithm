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

function formatCalendarKey(date: { year: number; month: number; day: number }): string {
	return `${date.year}-${String(date.month + 1).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Compute the Monday YYYY-MM-DD start key for a calendar date string, or undefined if invalid. */
export function weekStartForDate(value: string): string | undefined {
	const parsed = expiryDate(value);
	if (!parsed) return undefined;
	const day = new Date(0);
	day.setUTCFullYear(parsed.year, parsed.month, parsed.day);
	day.setUTCHours(12, 0, 0, 0);
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return formatCalendarKey({
		year: day.getUTCFullYear(),
		month: day.getUTCMonth(),
		day: day.getUTCDate()
	});
}

function weekDatesForStart(startDate: string): Set<string> | undefined {
	const parsed = expiryDate(startDate);
	if (!parsed) return undefined;
	const dates = new Set<string>();
	for (let offset = 0; offset < 7; offset++) {
		const day = new Date(0);
		day.setUTCFullYear(parsed.year, parsed.month, parsed.day + offset);
		day.setUTCHours(12, 0, 0, 0);
		dates.add(
			formatCalendarKey({
				year: day.getUTCFullYear(),
				month: day.getUTCMonth(),
				day: day.getUTCDate()
			})
		);
	}
	return dates;
}

/** Extract valid YYYY-MM-DD start dates for all active week:<startDate> scopes in shopping. */
export function activeWeeklyScopes(shopping: ShoppingItem[]): string[] {
	const weeks = new Set<string>();
	for (const item of shopping) {
		const match = item.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/);
		if (match && expiryDate(match[1])) weeks.add(match[1]);
	}
	return [...weeks];
}

/** Reconcile one weekly shopping scope against incomplete meals in that 7-day window. */
export function refreshWeekShopping(
	state: Pick<AppState, 'recipes' | 'pantry' | 'meals' | 'shopping'>,
	startDate: string,
	now: Date = new Date()
): ShoppingItem[] {
	const dates = weekDatesForStart(startDate);
	if (!dates) return state.shopping;
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const meals = state.meals.filter((meal) => !meal.completedAt && dates.has(meal.date));
	const additions = buildShoppingList(state.recipes, state.pantry, meals, safeNow);
	return reconcileShoppingList(state.shopping, additions, `week:${startDate}`);
}

/**
 * Reconcile explicit user shopping for a recipe or week scope.
 * Clears a recipe:<id> scope first when all of its existing rows are already checked,
 * while preserving partial mid-trip checked rows when unchecked rows remain.
 */
export function shopForScope(
	existing: ShoppingItem[],
	additions: ShoppingItem[],
	sourceKey: string
): { shopping: ShoppingItem[]; uncheckedCount: number } {
	const scopeItems = existing.filter((item) => item.sourceKey === sourceKey);
	const clearCompletedRecipeScope =
		sourceKey.startsWith('recipe:') &&
		scopeItems.length > 0 &&
		scopeItems.every((item) => item.checked);
	const baseline = clearCompletedRecipeScope
		? existing.filter((item) => item.sourceKey !== sourceKey)
		: existing;
	const shopping = reconcileShoppingList(baseline, additions, sourceKey);
	const uncheckedCount = shopping.filter(
		(item) => item.sourceKey === sourceKey && !item.checked
	).length;
	return { shopping, uncheckedCount };
}

function retireCheckedByScopeBudget(
	shopping: ShoppingItem[],
	budgetForScope: (scopeKey: string) => Map<string, number> | undefined
): ShoppingItem[] {
	const result: ShoppingItem[] = [];
	for (const item of shopping) {
		if (
			!item.checked ||
			!Number.isFinite(item.quantity) ||
			!(item.quantity > 0) ||
			!item.unit.trim()
		) {
			result.push({ ...item });
			continue;
		}
		const scopeBudget = budgetForScope(item.sourceKey ?? '');
		if (!scopeBudget) {
			result.push({ ...item });
			continue;
		}
		const key = bucketKey(item.name, item.unit);
		const availableBase = scopeBudget.get(key) ?? 0;
		if (!(availableBase > 0)) {
			result.push({ ...item });
			continue;
		}
		const unit = unitInfo(item.unit);
		const itemBase = item.quantity * unit.factor;
		const retiredBase = Math.min(itemBase, availableBase);
		scopeBudget.set(key, Math.max(0, availableBase - retiredBase));
		const remainingBase = Math.max(0, itemBase - retiredBase);
		const remainingQuantity = roundQuantity(remainingBase / unit.factor);
		if (remainingQuantity > 0) {
			result.push({ ...item, quantity: remainingQuantity });
		}
	}
	return result;
}

/**
 * Retire matching checked shopping rows in place up to the added non-expired pantry
 * quantities, tracked independently per shopping scope.
 */
export function retireCheckedShoppingItems(
	shopping: ShoppingItem[],
	additions: Array<Pick<Ingredient, 'name' | 'quantity' | 'unit' | 'expires'>>,
	now: Date = new Date()
): ShoppingItem[] {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const addedByBucket = new Map<string, number>();
	for (const item of additions) {
		if (!Number.isFinite(item.quantity) || !(item.quantity > 0) || !item.unit.trim()) continue;
		if (expiryStatus(item.expires, safeNow) === 'expired') continue;
		const key = bucketKey(item.name, item.unit);
		const unit = unitInfo(item.unit);
		addedByBucket.set(key, (addedByBucket.get(key) ?? 0) + item.quantity * unit.factor);
	}
	if (addedByBucket.size === 0) return shopping.map((item) => ({ ...item }));

	const budgetsByScope = new Map<string, Map<string, number>>();
	return retireCheckedByScopeBudget(shopping, (scopeKey) => {
		let budget = budgetsByScope.get(scopeKey);
		if (!budget) {
			budget = new Map(addedByBucket);
			budgetsByScope.set(scopeKey, budget);
		}
		return budget;
	});
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

/**
 * Add pantry entries, retire matching checked shopping rows per scope up to non-expired
 * added quantities, and refresh active weekly scopes once.
 */
export function addPantryItems(
	state: AppState,
	additions: ShoppingItem[],
	now: Date = new Date(),
	createId: () => string = () => globalThis.crypto.randomUUID()
): AppState {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const weeks = activeWeeklyScopes(state.shopping);
	const pantry = transferPurchasedItemsToPantry(state.pantry, additions, createId);
	let shopping = retireCheckedShoppingItems(state.shopping, additions, safeNow);
	for (const week of weeks) {
		shopping = refreshWeekShopping({ ...state, pantry, shopping }, week, safeNow);
	}
	return { ...state, pantry, shopping };
}

/**
 * Move all checked shopping purchases into pantry, remove those checked rows,
 * and refresh active weekly scopes once.
 */
export function movePurchasesToPantry(
	state: AppState,
	now: Date = new Date(),
	createId: () => string = () => globalThis.crypto.randomUUID()
): AppState {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const checked = state.shopping.filter((item) => item.checked);
	const weeks = activeWeeklyScopes(state.shopping);
	const pantry = transferPurchasedItemsToPantry(state.pantry, checked, createId);
	let shopping = state.shopping.filter((item) => !item.checked);
	for (const week of weeks) {
		shopping = refreshWeekShopping({ ...state, pantry, shopping }, week, safeNow);
	}
	return { ...state, pantry, shopping };
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
): { pantry: Ingredient[]; uncoveredByBucket: Map<string, number> } {
	const remaining = pantry.map((item) => ({ ...item }));
	const uncoveredByBucket = new Map<string, number>();
	if (!Number.isFinite(servings) || !(servings > 0)) {
		return { pantry: remaining, uncoveredByBucket };
	}
	const scale =
		Number.isFinite(recipe.servings) && recipe.servings > 0 ? servings / recipe.servings : 1;

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

		if (need > 0) {
			const key = bucketKey(ingredient.name, ingredient.unit);
			const unit = unitInfo(ingredient.unit);
			uncoveredByBucket.set(key, (uncoveredByBucket.get(key) ?? 0) + need * unit.factor);
		}
	}

	return { pantry: remaining, uncoveredByBucket };
}

/**
 * Mark a planned meal complete and optionally deduct its ingredient quantities from pantry
 * first, retiring any uncovered demand in place from the meal's weekly checked rows.
 */
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

	const weekStart = weekStartForDate(target.date);
	const weekSourceKey = weekStart ? `week:${weekStart}` : undefined;
	const hadWeekScope = weekSourceKey
		? state.shopping.some((item) => item.sourceKey === weekSourceKey)
		: false;

	let pantry = state.pantry;
	let shopping = state.shopping;

	if (options.deductPantry && recipe) {
		const consumed = consumePantry(state.pantry, recipe, target.servings, safeNow);
		pantry = consumed.pantry;
		if (weekSourceKey && consumed.uncoveredByBucket.size > 0) {
			const weekBudget = new Map(consumed.uncoveredByBucket);
			shopping = retireCheckedByScopeBudget(shopping, (scopeKey) =>
				scopeKey === weekSourceKey ? weekBudget : undefined
			);
		}
	}

	if (hadWeekScope && weekStart) {
		shopping = refreshWeekShopping({ ...state, meals, pantry, shopping }, weekStart, safeNow);
	}

	return { ...state, meals, pantry, shopping };
}
