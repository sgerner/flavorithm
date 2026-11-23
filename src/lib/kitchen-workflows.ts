import type { AppState, Ingredient, Meal, Recipe, ShoppingItem } from './types';
import {
	buildShoppingList,
	dateOrdinal,
	normalizeName,
	parseCalendarDate,
	parseIngredientInput,
	resolveShoppingQuantity,
	roundShoppingQuantity,
	unitInfo,
	type UnitInfo
} from './domain.ts';
import { MAX_SHOPPING_QUANTITY } from './recipe-draft.ts';
export {
	normalizeName,
	normalizeName as normalizeIngredientName,
	parseIngredientInput,
	parseIngredientLine,
	parseIngredientLines,
	unitInfo,
	type ParsedIngredient
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

export type PantryDraft = {
	id: string;
	quantity: number | string | null;
	unit: string;
	category: string;
	expires: string;
};

export type PantryCategoryOption = {
	key: string;
	label: string;
	count: number;
};

export function normalizePantryDraft(
	draft: Pick<PantryDraft, 'quantity' | 'unit' | 'category' | 'expires'>
): Pick<Ingredient, 'quantity' | 'unit' | 'category' | 'expires'> {
	const rawQuantity =
		draft.quantity === null ||
		draft.quantity === undefined ||
		(typeof draft.quantity === 'string' && draft.quantity.trim() === '')
			? 0
			: Number(draft.quantity);
	const clampedQuantity = Number.isFinite(rawQuantity)
		? Math.max(0, Math.min(rawQuantity, 1_000_000))
		: 0;
	const quantity = Object.is(clampedQuantity, -0) ? 0 : clampedQuantity;
	const unit = (draft.unit ?? '').trim().slice(0, 40) || 'piece';
	const category = (draft.category ?? '').trim().slice(0, 100) || 'Pantry';
	const expires = (draft.expires ?? '').trim().slice(0, 50) || undefined;
	return expires ? { quantity, unit, category, expires } : { quantity, unit, category };
}

export function listPantryCategories(
	pantry: Ingredient[],
	activeCategory = 'all'
): PantryCategoryOption[] {
	const byKey = new Map<string, PantryCategoryOption>();
	for (const item of pantry) {
		const label = item.category?.trim() || 'Pantry';
		const key = label.toLowerCase();
		const existing = byKey.get(key);
		if (existing) existing.count += 1;
		else byKey.set(key, { key, label, count: 1 });
	}
	const activeTrimmed = activeCategory.trim();
	const activeKey = activeTrimmed.toLowerCase();
	if (activeTrimmed && activeKey !== 'all' && !byKey.has(activeKey)) {
		byKey.set(activeKey, { key: activeKey, label: activeTrimmed, count: 0 });
	}
	return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function filterPantryItems(
	pantry: Ingredient[],
	filters: { query?: string; category?: string; expiry?: string },
	now: Date = new Date()
): Ingredient[] {
	const search = (filters.query ?? '').trim().toLowerCase();
	const selectedCategory = (filters.category ?? 'all').trim().toLowerCase() || 'all';
	const selectedExpiry = (filters.expiry ?? 'all').trim().toLowerCase() || 'all';
	return pantry.filter((item) => {
		const itemCategory = item.category?.trim() || 'Pantry';
		if (selectedExpiry !== 'all' && expiryStatus(item.expires, now) !== selectedExpiry) {
			return false;
		}
		if (selectedCategory !== 'all' && itemCategory.toLowerCase() !== selectedCategory) {
			return false;
		}
		if (search && !`${item.name} ${itemCategory} ${item.unit}`.toLowerCase().includes(search)) {
			return false;
		}
		return true;
	});
}

function calendarDate(value: Date): { year: number; month: number; day: number } | undefined {
	if (!Number.isFinite(value.getTime())) return undefined;
	return { year: value.getFullYear(), month: value.getMonth(), day: value.getDate() };
}

/** Classify an expiry by local calendar day; date-only and ISO strings never shift by timezone. */
export function expiryStatus(expires?: string, now: Date = new Date()): ExpiryStatus {
	if (!expires?.trim()) return 'unknown';
	const expiry = parseCalendarDate(expires);
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
		const expectedQuantity = Math.min(
			MAX_SHOPPING_QUANTITY,
			roundShoppingQuantity(item.requirementQuantity / unitInfo(item.unit).factor)
		);
		if (Math.abs(item.quantity - expectedQuantity) > 1e-6) return true;
	}
	return false;
}

/**
 * Replace one generated shopping-list scope while retaining manual entries, other scopes,
 * customized active rows, and checked purchases. Checked purchases credit their original bucket
 * and follow unchecked items.
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
			units: UnitInfo[];
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
			units: [],
			quantityBase: 0
		};
		bucket.quantityBase += addition.quantity * unit.factor;
		bucket.units.push(unit);
		additionBuckets.set(key, bucket);
	}

	const checked = existing.filter((item) => item.sourceKey === sourceKey && item.checked);
	const checkedByBucket = new Map<string, { quantityBase: number; units: UnitInfo[] }>();
	for (const item of checked) {
		if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
		const currentKey = bucketKey(item.name, item.unit);
		const currentUnit = unitInfo(item.unit);
		const targetKey = item.requirementKey
			? normalizeLegacyBucketKey(item.requirementKey)
			: currentKey;
		const targetDimension = splitBucketKey(targetKey)?.dimension;
		const checkedBucket = checkedByBucket.get(targetKey) ?? { quantityBase: 0, units: [] };
		let creditBase: number;
		if (targetDimension === undefined || currentUnit.dimension === targetDimension) {
			creditBase = item.quantity * currentUnit.factor;
			checkedBucket.units.push(currentUnit);
		} else if (
			item.requirementQuantity !== undefined &&
			Number.isFinite(item.requirementQuantity) &&
			item.requirementQuantity > 0
		) {
			creditBase = item.requirementQuantity;
		} else {
			creditBase = additionBuckets.get(targetKey)?.quantityBase ?? 0;
		}
		checkedBucket.quantityBase += creditBase;
		checkedByBucket.set(targetKey, checkedBucket);
	}

	const resolveBucketRemainder = (
		key: string,
		bucket: { units: UnitInfo[]; quantityBase: number }
	) => {
		const checkedBucket = checkedByBucket.get(key);
		const rawRemainingBase = bucket.quantityBase - (checkedBucket?.quantityBase ?? 0);
		const resolved = resolveShoppingQuantity(rawRemainingBase, [
			...bucket.units,
			...(checkedBucket?.units ?? [])
		]);
		return resolved ? { rawRemainingBase, resolved } : undefined;
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
			const origBucket = additionBuckets.get(origKey);
			let matchedRemainder = origBucket ? resolveBucketRemainder(origKey, origBucket) : undefined;
			if (matchedRemainder) {
				matchedKey = origKey;
			} else {
				for (const [candidateKey, candidateBucket] of additionBuckets) {
					if (candidateBucket.normalizedName !== origIngredient) continue;
					const candidateRemainder = resolveBucketRemainder(candidateKey, candidateBucket);
					if (candidateRemainder) {
						matchedKey = candidateKey;
						matchedRemainder = candidateRemainder;
						break;
					}
				}
			}
			if (matchedKey && matchedRemainder) {
				coveredByCustomized.add(matchedKey);
				retained.push({
					...item,
					customized: true,
					requirementKey: matchedKey,
					requirementQuantity: matchedRemainder.rawRemainingBase
				});
			}
			continue;
		}
		if (!existingUncheckedIds.has(origKey)) existingUncheckedIds.set(origKey, item.id);
	}

	const uncheckedRetained = retained.filter((item) => !item.checked);
	const checkedRetained = retained.filter((item) => item.checked);
	const usedIds = new Set(retained.map((item) => item.id));
	const generated: ShoppingItem[] = [];
	for (const [key, bucket] of additionBuckets) {
		if (coveredByCustomized.has(key)) continue;
		const remainder = resolveBucketRemainder(key, bucket);
		if (!remainder) continue;
		const { rawRemainingBase, resolved } = remainder;
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
			quantity: Math.min(MAX_SHOPPING_QUANTITY, resolved.quantity),
			unit: resolved.unit.display,
			checked: false,
			sourceKey,
			requirementKey: key,
			requirementQuantity: Math.min(rawRemainingBase, MAX_SHOPPING_QUANTITY * resolved.unit.factor)
		});
	}

	return [...uncheckedRetained, ...generated, ...checkedRetained].slice(0, 1_000);
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

const MAX_SHOPPING_ITEMS = 1_000;

function formatDateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function nextFreeItemId(item: ShoppingItem, usedIds: Set<string>): string {
	if (item.sourceKey) {
		const key = item.requirementKey
			? normalizeLegacyBucketKey(item.requirementKey)
			: bucketKey(item.name, item.unit);
		return nextFreeGeneratedId(item.sourceKey, key, usedIds);
	}
	let suffix = 2;
	let suffixText = `-${suffix}`;
	let candidate = `${item.id.slice(0, 100 - suffixText.length)}${suffixText}`;
	while (usedIds.has(candidate)) {
		suffixText = `-${++suffix}`;
		candidate = `${item.id.slice(0, 100 - suffixText.length)}${suffixText}`;
	}
	usedIds.add(candidate);
	return candidate;
}

function reconcileWeekScope(
	shopping: ShoppingItem[],
	state: Pick<AppState, 'recipes' | 'pantry' | 'meals'>,
	sourceKey: string | undefined,
	now: Date
): ShoppingItem[] {
	const match = /^week:(\d{4}-\d{2}-\d{2})$/.exec(sourceKey ?? '');
	if (!match) return shopping;
	const startKey = match[1];
	const start = new Date(`${startKey}T12:00:00`);
	if (!Number.isFinite(start.getTime()) || formatDateKey(start) !== startKey) return shopping;
	const dates = new Set(
		Array.from({ length: 7 }, (_, index) => {
			const day = new Date(start);
			day.setDate(day.getDate() + index);
			return formatDateKey(day);
		})
	);
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const meals = state.meals.filter((meal) => !meal.completedAt && dates.has(meal.date));
	const additions = buildShoppingList(state.recipes, state.pantry, meals, safeNow);
	return reconcileShoppingList(shopping, additions, `week:${startKey}`);
}

/**
 * Remove one shopping row by ID and refresh its weekly meal-plan scope when a checked
 * purchase is deleted. Unchecked deletions skip weekly reconciliation so dismissed
 * deficits do not immediately reappear.
 */
export function deleteShoppingItem(
	state: Pick<AppState, 'shopping' | 'recipes' | 'pantry' | 'meals'>,
	itemId: string,
	now: Date = new Date()
): ShoppingItem[] {
	const removed = state.shopping.find((item) => item.id === itemId);
	if (!removed) return state.shopping;
	const remaining = state.shopping.filter((item) => item.id !== itemId);
	if (!removed.checked) return remaining;
	const reconciled = reconcileWeekScope(remaining, state, removed.sourceKey, now);
	return reconciled.length > MAX_SHOPPING_ITEMS ? remaining : reconciled;
}

/**
 * Restore a deleted shopping row while preserving unique IDs, checked purchases, and the
 * 1,000-item kitchen limit. Colliding unchecked rows in the same scope have a restored
 * checked purchase deducted or are re-keyed, and weekly scopes are reconciled so split
 * remainder rows do not duplicate deficits.
 */
export function restoreShoppingItem(
	state: Pick<AppState, 'shopping' | 'recipes' | 'pantry' | 'meals'>,
	removed: ShoppingItem,
	now: Date = new Date()
): ShoppingItem[] {
	const existing = state.shopping;
	if (existing.some((entry) => entry.id === removed.id && entry.checked)) return existing;

	const collisionIndex = existing.findIndex((entry) => entry.id === removed.id);
	const restoredItem: ShoppingItem = { ...removed };
	let next: ShoppingItem[];

	if (collisionIndex === -1) {
		next = [...existing, restoredItem];
	} else {
		const colliding = existing[collisionIndex];
		const usedIds = new Set(existing.map((entry) => entry.id));
		usedIds.add(restoredItem.id);

		const replacement: ShoppingItem[] = [restoredItem];
		if (colliding.sourceKey === restoredItem.sourceKey) {
			if (restoredItem.checked) {
				if (
					bucketKey(colliding.name, colliding.unit) ===
					bucketKey(restoredItem.name, restoredItem.unit)
				) {
					const collidingUnit = unitInfo(colliding.unit);
					const restoredUnit = unitInfo(restoredItem.unit);
					const collidingBase =
						Number.isFinite(colliding.quantity) && colliding.quantity > 0
							? colliding.quantity * collidingUnit.factor
							: 0;
					const restoredBase =
						Number.isFinite(restoredItem.quantity) && restoredItem.quantity > 0
							? restoredItem.quantity * restoredUnit.factor
							: 0;
					const resolved = resolveShoppingQuantity(collidingBase - restoredBase, [
						collidingUnit,
						restoredUnit
					]);
					if (resolved) {
						replacement.push({
							...colliding,
							id: nextFreeItemId(colliding, usedIds),
							quantity: Math.min(MAX_SHOPPING_QUANTITY, resolved.quantity),
							unit: resolved.unit.display,
							...(colliding.requirementQuantity !== undefined && !colliding.customized
								? {
										requirementQuantity: Math.min(
											collidingBase - restoredBase,
											MAX_SHOPPING_QUANTITY * resolved.unit.factor
										)
									}
								: {})
						});
					}
				} else {
					replacement.push({
						...colliding,
						id: nextFreeItemId(colliding, usedIds)
					});
				}
			}
		} else {
			replacement.push({
				...colliding,
				id: nextFreeItemId(colliding, usedIds)
			});
		}

		next = [
			...existing.slice(0, collisionIndex),
			...replacement,
			...existing.slice(collisionIndex + 1)
		];
	}

	const reconciled = restoredItem.checked
		? reconcileWeekScope(next, state, restoredItem.sourceKey, now)
		: next;
	return reconciled.length > MAX_SHOPPING_ITEMS ? existing : reconciled;
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
		{ name: string; unit: ReturnType<typeof unitInfo>; quantityBase: number; category?: string }
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
		const clampedName = resolvedName.trim().slice(0, 200);
		if (!clampedName) continue;
		const normalizedName = normalizeName(clampedName);
		const unit = unitInfo(resolvedUnit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const bucket = buckets.get(key) ?? {
			name: clampedName,
			unit,
			quantityBase: 0
		};
		bucket.quantityBase += resolvedQuantity * unit.factor;
		const category = item.category?.trim();
		if (category && (!bucket.category || (bucket.category === 'Pantry' && category !== 'Pantry'))) {
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
				unitInfo(item.unit.trim() || 'each').dimension === bucket.unit.dimension &&
				!item.expires?.trim()
		);
		if (destination) {
			const destinationUnit = destination.unit.trim() || 'each';
			if (!destination.unit.trim()) destination.unit = 'each';
			const baseline = Number.isFinite(destination.quantity)
				? Math.max(0, destination.quantity)
				: 0;
			destination.quantity = Math.min(
				1_000_000,
				roundPantryQuantity(baseline + bucket.quantityBase / unitInfo(destinationUnit).factor)
			);
			continue;
		}
		if (result.length >= 1_000) continue;

		const baseId = createId();
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
		usedIds.add(id);
		result.push({
			id,
			name: bucket.name,
			quantity: Math.min(1_000_000, roundPantryQuantity(bucket.quantityBase / bucket.unit.factor)),
			unit: bucket.unit.display.slice(0, 40),
			category: bucket.category?.slice(0, 100) || 'Pantry'
		});
	}
	return result;
}

function recipeForMeal(state: AppState, meal: Meal): Recipe | undefined {
	return state.recipes.find((recipe) => recipe.id === meal.recipeId);
}

function expiryPriority(expires: string | undefined, now: Date): number {
	const expiry = expires ? parseCalendarDate(expires) : undefined;
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
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
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
			.filter(({ item }) => {
				const status = expiryStatus(item.expires, safeNow);
				return status !== 'expired' && (!item.expires?.trim() || status !== 'unknown');
			})
			.sort(
				(a, b) =>
					expiryPriority(a.item.expires, safeNow) - expiryPriority(b.item.expires, safeNow) ||
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
