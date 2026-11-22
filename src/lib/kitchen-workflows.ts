import type { AppState, Ingredient, Meal, Recipe, ShoppingItem } from './types';
import { normalizeName, parseIngredientInput, unitInfo } from './domain.ts';
export {
	normalizeName,
	normalizeName as normalizeIngredientName,
	parseIngredientInput,
	unitInfo
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

const REQUIREMENT_KEY_SEPARATOR = '::';

function bucketKey(name: string, unit: string): string {
	return `${normalizeName(name)}${REQUIREMENT_KEY_SEPARATOR}${unitInfo(unit).dimension}`;
}

function normalizeLegacyBucketKey(key: string): string {
	const nullSep = key.indexOf('\u0000');
	if (nullSep !== -1) {
		return `${key.slice(0, nullSep)}${REQUIREMENT_KEY_SEPARATOR}${key.slice(nullSep + 1)}`;
	}
	return key;
}

function splitBucketKey(key: string): { ingredient: string; dimension: string } | undefined {
	const normalized = normalizeLegacyBucketKey(key);
	const sep = normalized.lastIndexOf(REQUIREMENT_KEY_SEPARATOR);
	if (sep === -1) return undefined;
	return {
		ingredient: normalized.slice(0, sep),
		dimension: normalized.slice(sep + REQUIREMENT_KEY_SEPARATOR.length)
	};
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
	const parts = splitBucketKey(key);
	const hashInput = parts ? `${parts.ingredient}\u0000${parts.dimension}` : key;
	return `generated-${stableHash(`${sourceKey}\u0000${hashInput}`)}`;
}

function nextFreeGeneratedId(sourceKey: string, key: string, usedIds: Set<string>): string {
	const baseId = generatedShoppingId(sourceKey, key);
	let candidate = baseId;
	let suffix = 2;
	while (usedIds.has(candidate)) candidate = `${baseId}-${suffix++}`;
	usedIds.add(candidate);
	return candidate;
}

/** Extract Monday week-start keys (YYYY-MM-DD) for all active weekly shopping scopes. */
export function activeShoppingWeeks(shopping: ShoppingItem[]): string[] {
	return [
		...new Set(
			shopping.flatMap((item) => item.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1] ?? [])
		)
	];
}

/** Compute the Monday calendar key (YYYY-MM-DD) for a YYYY-MM-DD date string. */
export function weekStartForDate(value: string): string {
	const date = new Date(`${value}T12:00:00`);
	if (Number.isNaN(date.getTime())) return value;
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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

function isCustomizedRow(item: ShoppingItem): boolean {
	if (item.customized === true) return true;
	if (!item.requirementKey) return false;
	const expectedKey = normalizeLegacyBucketKey(item.requirementKey);
	if (bucketKey(item.name, item.unit) !== expectedKey) return true;
	if (
		item.requirementQuantity !== undefined &&
		Number.isFinite(item.requirementQuantity) &&
		Number.isFinite(item.quantity)
	) {
		const currentBase = item.quantity * unitInfo(item.unit).factor;
		if (Math.abs(currentBase - item.requirementQuantity) > 1e-6) return true;
	}
	return false;
}

/**
 * Replace one generated shopping-list scope while retaining manual entries, other scopes,
 * customized active rows, and checked purchases. Checked purchases credit their original bucket.
 */
export function reconcileShoppingList(
	existing: ShoppingItem[],
	additions: ShoppingItem[],
	sourceKey: string
): ShoppingItem[] {
	const additionBuckets = new Map<
		string,
		{
			item: ShoppingItem;
			normalizedName: string;
			unit: ReturnType<typeof unitInfo>;
			quantityBase: number;
		}
	>();
	for (const addition of additions) {
		if (!Number.isFinite(addition.quantity) || addition.quantity <= 0) continue;
		const normalizedName = normalizeName(addition.name);
		const key = bucketKey(addition.name, addition.unit);
		const unit = unitInfo(addition.unit);
		const bucket = additionBuckets.get(key) ?? {
			item: addition,
			normalizedName,
			unit,
			quantityBase: 0
		};
		bucket.quantityBase += addition.quantity * unit.factor;
		additionBuckets.set(key, bucket);
	}

	const checked = existing.filter((item) => item.sourceKey === sourceKey && item.checked);
	const checkedByBucket = new Map<string, number>();
	for (const item of checked) {
		if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
		const currentKey = bucketKey(item.name, item.unit);
		const currentUnit = unitInfo(item.unit);
		const targetKey = item.requirementKey
			? normalizeLegacyBucketKey(item.requirementKey)
			: currentKey;
		const targetDimension = splitBucketKey(targetKey)?.dimension;
		let creditBase: number;
		if (targetDimension === undefined || currentUnit.dimension === targetDimension) {
			creditBase = item.quantity * currentUnit.factor;
		} else if (
			item.requirementQuantity !== undefined &&
			Number.isFinite(item.requirementQuantity) &&
			item.requirementQuantity > 0
		) {
			creditBase = item.requirementQuantity;
		} else {
			creditBase = additionBuckets.get(targetKey)?.quantityBase ?? 0;
		}
		checkedByBucket.set(targetKey, (checkedByBucket.get(targetKey) ?? 0) + creditBase);
	}

	const remainingBucketQuantity = (
		key: string,
		bucket: { unit: ReturnType<typeof unitInfo>; quantityBase: number }
	) => {
		const alreadyPurchased = checkedByBucket.get(key) ?? 0;
		const remainingBase = Math.max(0, bucket.quantityBase - alreadyPurchased);
		return roundQuantity(remainingBase / bucket.unit.factor);
	};

	const existingUncheckedIds = new Map<string, string>();
	const retained: ShoppingItem[] = [];
	const coveredByCustomized = new Set<string>();

	for (const item of existing) {
		if (item.sourceKey !== sourceKey || item.checked) {
			retained.push(item);
			continue;
		}
		const origKey = item.requirementKey
			? normalizeLegacyBucketKey(item.requirementKey)
			: bucketKey(item.name, item.unit);
		if (isCustomizedRow(item)) {
			const origIngredient = splitBucketKey(origKey)?.ingredient ?? normalizeName(item.name);
			let matchedKey: string | undefined;
			let matchedBucket = additionBuckets.get(origKey);
			if (matchedBucket && remainingBucketQuantity(origKey, matchedBucket) > 0) {
				matchedKey = origKey;
			} else {
				matchedBucket = undefined;
				for (const [candidateKey, candidateBucket] of additionBuckets) {
					if (
						candidateBucket.normalizedName === origIngredient &&
						remainingBucketQuantity(candidateKey, candidateBucket) > 0
					) {
						matchedKey = candidateKey;
						matchedBucket = candidateBucket;
						break;
					}
				}
			}
			if (matchedKey && matchedBucket) {
				const remQty = remainingBucketQuantity(matchedKey, matchedBucket);
				coveredByCustomized.add(matchedKey);
				retained.push({
					...item,
					customized: true,
					requirementKey: matchedKey,
					requirementQuantity: remQty * matchedBucket.unit.factor
				});
			}
			continue;
		}
		if (!existingUncheckedIds.has(origKey)) existingUncheckedIds.set(origKey, item.id);
	}

	const usedIds = new Set(retained.map((item) => item.id));
	const generated: ShoppingItem[] = [];
	for (const [key, bucket] of additionBuckets) {
		if (coveredByCustomized.has(key)) continue;
		const remainingQuantity = remainingBucketQuantity(key, bucket);
		if (remainingQuantity <= 0) continue;
		const reusableId = existingUncheckedIds.get(key);
		let id: string;
		if (reusableId && !usedIds.has(reusableId)) {
			id = reusableId;
			usedIds.add(id);
		} else {
			id = nextFreeGeneratedId(sourceKey, key, usedIds);
		}
		const { customized: _ignored, ...baseItem } = bucket.item;
		generated.push({
			...baseItem,
			id,
			quantity: remainingQuantity,
			unit: bucket.unit.display,
			checked: false,
			sourceKey,
			requirementKey: key,
			requirementQuantity: remainingQuantity * bucket.unit.factor
		});
	}

	return [...retained, ...generated];
}

/** Check whether a shopping row is a valid checked purchase that can be transferred to pantry. */
export function isTransferablePurchase(item: ShoppingItem): boolean {
	return (
		Boolean(item.checked) &&
		Boolean(item.name?.trim()) &&
		Number.isFinite(item.quantity) &&
		item.quantity > 0
	);
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
		if (!isTransferablePurchase(item)) continue;
		let resolvedName = item.name.trim();
		let resolvedQuantity = item.quantity;
		let resolvedUnit = item.unit.trim() || 'each';
		if (
			item.quantity === 1 &&
			(!item.unit.trim() ||
				['piece', 'pieces', 'each', 'ea'].includes(item.unit.trim().toLowerCase()))
		) {
			const parsed = parseIngredientInput(resolvedName);
			if (parsed.hasExplicitQuantity && parsed.hasExplicitUnit && parsed.name) {
				resolvedName = parsed.name;
				resolvedQuantity = parsed.quantity;
				resolvedUnit = parsed.unit;
			}
		}
		const normalizedName = normalizeName(resolvedName);
		const unit = unitInfo(resolvedUnit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const bucket = buckets.get(key) ?? { name: resolvedName, unit, quantityBase: 0 };
		bucket.quantityBase += resolvedQuantity * unit.factor;
		buckets.set(key, bucket);
	}

	const usedIds = new Set(result.map((item) => item.id));
	for (const [key, bucket] of buckets) {
		const [normalizedName] = key.split('\u0000');
		const destination = result.find(
			(item) =>
				normalizeName(item.name) === normalizedName &&
				unitInfo(item.unit.trim() || 'each').dimension === bucket.unit.dimension &&
				!item.expires?.trim()
		);
		if (destination) {
			const destinationUnit = destination.unit.trim() || 'each';
			if (!destination.unit.trim()) destination.unit = 'each';
			destination.quantity = roundPantryQuantity(
				destination.quantity + bucket.quantityBase / unitInfo(destinationUnit).factor
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
