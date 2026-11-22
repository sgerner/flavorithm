import type { AppState, Ingredient, Meal, Recipe, ShoppingItem } from './types';
import { expiryStatus, normalizeName, unitInfo } from './domain.ts';
export {
	expiryStatus,
	indexUsablePantry,
	matchRecipePantry,
	normalizeName,
	normalizeName as normalizeIngredientName,
	unitInfo,
	type ExpiryStatus,
	type PantryLotIndex,
	type RecipePantryMatch
} from './domain.ts';

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

export type RecognizedPantryItem = {
	name: string;
	quantity: number;
	unit: string;
	category: string;
};

export type StagedPantryItem = {
	id: string;
	name: string;
	quantity: number;
	unit: string;
	category: string;
};

export type PantryAddition = {
	name: string;
	quantity: number;
	unit: string;
	category?: string;
};

/** Stage recognized AI vision ingredients for review with clean names, units, and categories. */
export function stageScannedIngredients(
	existing: StagedPantryItem[],
	recognized: RecognizedPantryItem[],
	createId: () => string = () => globalThis.crypto.randomUUID()
): StagedPantryItem[] {
	const staged = existing.map((item) => ({ ...item }));
	const usedIds = new Set(staged.map((item) => item.id));
	for (const item of recognized) {
		const name = item.name.trim().slice(0, 100);
		if (!name || !Number.isFinite(item.quantity) || !(item.quantity > 0) || !item.unit.trim())
			continue;
		const baseId = createId();
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
		usedIds.add(id);
		staged.push({
			id,
			name,
			quantity: roundPantryQuantity(item.quantity),
			unit: unitInfo(item.unit).display.slice(0, 40) || 'each',
			category: item.category.trim().slice(0, 60) || 'Pantry'
		});
	}
	return staged;
}

/** Parse comma-, semicolon-, or newline-separated manual pantry entries. */
export function parseManualPantryInput(input: string): PantryAddition[] {
	return input
		.split(/[,\n;]/)
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => {
			const match = value.match(
				/^(\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?|ml|l|cups?|tbsp|tsp|pieces?|whole|each|cans?|cloves?|bunch)?\s+(.+)$/i
			);
			return {
				name: match ? match[3] : value,
				quantity: match ? Number(match[1]) : 1,
				unit: match?.[2] || 'piece',
				category: 'Pantry'
			};
		});
}

/** Merge structured or manual additions into pantry stock while preserving recognized categories. */
export function mergePantryAdditions(
	pantry: Ingredient[],
	additions: PantryAddition[],
	createId: () => string = () => globalThis.crypto.randomUUID()
): Ingredient[] {
	const result = pantry.map((item) => ({ ...item }));
	const buckets = new Map<
		string,
		{ name: string; unit: ReturnType<typeof unitInfo>; quantityBase: number; category: string }
	>();
	for (const item of additions) {
		const trimmedName = item.name.trim().slice(0, 100);
		const quantity = Number(item.quantity);
		const trimmedUnit = item.unit.trim();
		if (!trimmedName || !Number.isFinite(quantity) || !(quantity > 0) || !trimmedUnit) continue;
		const normalizedName = normalizeName(trimmedName);
		if (!normalizedName) continue;
		const unit = unitInfo(trimmedUnit);
		const category = item.category?.trim().slice(0, 60) || 'Pantry';
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const bucket = buckets.get(key) ?? {
			name: trimmedName,
			unit,
			quantityBase: 0,
			category
		};
		bucket.quantityBase += quantity * unit.factor;
		if (bucket.category === 'Pantry' && category !== 'Pantry') {
			bucket.category = category;
		}
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
			if (
				(!destination.category.trim() || destination.category === 'Pantry') &&
				bucket.category !== 'Pantry'
			) {
				destination.category = bucket.category;
			}
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
			unit: bucket.unit.display.slice(0, 40),
			category: bucket.category || 'Pantry'
		});
	}
	return result;
}

/** Move checked purchases into pantry stock, merging aliases and compatible units safely. */
export function transferPurchasedItemsToPantry(
	pantry: Ingredient[],
	purchases: ShoppingItem[],
	createId: () => string = () => globalThis.crypto.randomUUID()
): Ingredient[] {
	return mergePantryAdditions(
		pantry,
		purchases
			.filter((item) => item.checked)
			.map((item) => ({
				name: item.name,
				quantity: item.quantity,
				unit: item.unit,
				category: 'Pantry'
			})),
		createId
	);
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
