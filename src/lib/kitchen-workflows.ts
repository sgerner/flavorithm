import type { AppState, Ingredient, Meal, Recipe, ShoppingItem } from './types';
import {
	buildShoppingList,
	consumeRecipeFromPantry,
	deductRecipeFromPantry,
	expiryStatus,
	normalizeName,
	parseCalendarDate,
	parseIngredientLines,
	resolveShoppingQuantity,
	roundShoppingQuantity,
	unitInfo,
	type UnitInfo
} from './domain.ts';
import { MAX_SHOPPING_QUANTITY } from './recipe-draft.ts';
import { seedPantry, seedRecipes } from './data.ts';
export {
	consumeRecipeFromPantry,
	deductRecipeFromPantry,
	expiryStatus,
	indexUsablePantry,
	matchRecipePantry,
	msUntilNextLocalMidnight,
	normalizeName,
	normalizeName as normalizeIngredientName,
	parseIngredientLine,
	parseIngredientLines,
	unitInfo,
	type ExpiryStatus,
	type PantryLotIndex,
	type ParsedIngredient,
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
		if (selectedExpiry === 'soon' && !(item.quantity > 0)) {
			return false;
		}
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

/**
 * Replace one generated shopping-list scope while retaining manual entries, other scopes,
 * and checked purchases. Checked purchases reduce matching quantities in the refreshed list
 * and follow unchecked items.
 */
export function reconcileShoppingList(
	existing: ShoppingItem[],
	additions: ShoppingItem[],
	sourceKey: string
): ShoppingItem[] {
	const checked = existing.filter((item) => item.sourceKey === sourceKey && item.checked);
	const checkedByBucket = new Map<string, { quantityBase: number; units: UnitInfo[] }>();
	for (const item of checked) {
		if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
		const key = bucketKey(item.name, item.unit);
		const unit = unitInfo(item.unit);
		const bucket = checkedByBucket.get(key) ?? { quantityBase: 0, units: [] };
		bucket.quantityBase += item.quantity * unit.factor;
		bucket.units.push(unit);
		checkedByBucket.set(key, bucket);
	}
	const existingUncheckedIds = new Map<string, string>();
	for (const item of existing) {
		if (item.sourceKey !== sourceKey || item.checked) continue;
		const key = bucketKey(item.name, item.unit);
		if (!existingUncheckedIds.has(key)) existingUncheckedIds.set(key, item.id);
	}

	const retained = existing.filter((item) => item.sourceKey !== sourceKey || item.checked);
	const uncheckedRetained = retained.filter((item) => !item.checked);
	const checkedRetained = retained.filter((item) => item.checked);
	const usedIds = new Set(retained.map((item) => item.id));
	const additionBuckets = new Map<
		string,
		{ item: ShoppingItem; units: UnitInfo[]; quantityBase: number }
	>();
	for (const addition of additions) {
		if (!Number.isFinite(addition.quantity) || addition.quantity <= 0) continue;
		const key = bucketKey(addition.name, addition.unit);
		const unit = unitInfo(addition.unit);
		const bucket = additionBuckets.get(key) ?? { item: addition, units: [], quantityBase: 0 };
		bucket.quantityBase += addition.quantity * unit.factor;
		bucket.units.push(unit);
		additionBuckets.set(key, bucket);
	}

	const generated: ShoppingItem[] = [];
	for (const [key, bucket] of additionBuckets) {
		const checkedBucket = checkedByBucket.get(key);
		const resolved = resolveShoppingQuantity(
			bucket.quantityBase - (checkedBucket?.quantityBase ?? 0),
			[...bucket.units, ...(checkedBucket?.units ?? [])]
		);
		if (!resolved) continue;
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
			quantity: Math.min(MAX_SHOPPING_QUANTITY, resolved.quantity),
			unit: resolved.unit.display,
			checked: false,
			sourceKey
		});
	}

	return [...uncheckedRetained, ...generated, ...checkedRetained].slice(0, 1_000);
}

export type ShoppingItemSnapshot = Pick<ShoppingItem, 'name' | 'quantity' | 'unit'>;

export interface ShoppingItemDraft {
	name: string;
	quantity: number | null;
	unit: string;
}

/** Clamp and trim a shopping item's editable fields so inline edits remain valid. */
export function normalizeShoppingItem(
	item: ShoppingItem,
	draft?: ShoppingItemDraft | null
): ShoppingItem {
	const fallbackName = item.name.trim().slice(0, 200) || 'Shopping item';
	const name = (draft ? draft.name : item.name).trim().slice(0, 200) || fallbackName;
	const unit = (draft ? draft.unit : item.unit).trim().slice(0, 40) || 'piece';
	const rawQuantity: unknown = draft ? draft.quantity : item.quantity;
	const parsed =
		rawQuantity === null ||
		rawQuantity === undefined ||
		(typeof rawQuantity === 'string' && !rawQuantity.trim())
			? Number.NaN
			: Number(rawQuantity);
	const fallbackQuantity =
		Number.isFinite(item.quantity) &&
		item.quantity >= 0.01 &&
		item.quantity <= MAX_SHOPPING_QUANTITY
			? item.quantity
			: 1;
	const quantity = Number.isFinite(parsed)
		? Math.max(0.01, Math.min(parsed, MAX_SHOPPING_QUANTITY))
		: fallbackQuantity;
	item.name = name;
	item.unit = unit;
	item.quantity = quantity;
	if (draft) {
		draft.name = name;
		draft.unit = unit;
		draft.quantity = quantity;
	}
	return item;
}

/** Capture a shopping item's editable fields before inline editing begins. */
export function snapshotShoppingItem(item: ShoppingItem): ShoppingItemSnapshot {
	return {
		name: item.name,
		quantity: item.quantity,
		unit: item.unit
	};
}

/** Restore a shopping item's editable fields from a pre-edit snapshot. */
export function revertShoppingItem(
	item: ShoppingItem,
	snapshot: ShoppingItemSnapshot
): ShoppingItem {
	item.name = snapshot.name;
	item.quantity = snapshot.quantity;
	item.unit = snapshot.unit;
	return normalizeShoppingItem(item);
}

const MAX_SHOPPING_ITEMS = 1_000;

function formatCalendarKey(date: { year: number; month: number; day: number }): string {
	return `${date.year}-${String(date.month + 1).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Compute the Monday YYYY-MM-DD start key for a calendar date string, or undefined if invalid. */
export function weekStartForDate(value: string): string | undefined {
	const parsed = parseCalendarDate(value);
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
	const parsed = parseCalendarDate(startDate);
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
		if (match && parseCalendarDate(match[1])) weeks.add(match[1]);
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

function nextFreeItemId(item: ShoppingItem, usedIds: Set<string>): string {
	if (item.sourceKey) {
		return nextFreeGeneratedId(item.sourceKey, bucketKey(item.name, item.unit), usedIds);
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
	return refreshWeekShopping({ ...state, shopping }, match[1], now);
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
							unit: resolved.unit.display
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

export type RecognizedPantryItem = {
	name: string;
	quantity: number;
	unit: string;
	category: string;
};

export type StagedPantryItem = {
	id: string;
	name: string;
	quantity: number | string | null;
	unit: string;
	category: string;
};

export type PantryAddition = {
	name: string;
	quantity: number | string | null;
	unit: string;
	category?: string;
	expires?: string;
};

/** Normalize a staged scan row on blur without clamping empty quantities to 0.01. */
export function normalizeStagedScanDraft(item: StagedPantryItem): StagedPantryItem {
	item.name = (item.name ?? '').trim().slice(0, 100);
	item.unit = (item.unit ?? '').trim().slice(0, 40) || 'each';
	item.category = (item.category ?? '').trim().slice(0, 60) || 'Pantry';
	if (
		item.quantity === null ||
		item.quantity === undefined ||
		(typeof item.quantity === 'string' && item.quantity.trim() === '')
	) {
		item.quantity = null;
		return item;
	}
	const parsed = Number(item.quantity);
	item.quantity =
		Number.isFinite(parsed) && parsed > 0
			? roundPantryQuantity(Math.min(parsed, 1_000_000))
			: parsed === 0
				? 0
				: null;
	return item;
}

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
	return parseIngredientLines(input);
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
		const remainingQuantity =
			remainingBase > 0.00001 ? roundShoppingQuantity(remainingBase / unit.factor) : 0;
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
		const status = expiryStatus(item.expires, safeNow);
		if (status === 'expired' || (Boolean(item.expires?.trim()) && status === 'unknown')) continue;
		const normalizedName = normalizeName(item.name);
		if (!normalizedName) continue;
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
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
	const datedAdditions: Array<{
		name: string;
		unit: ReturnType<typeof unitInfo>;
		quantityBase: number;
		category: string;
		expires: string;
	}> = [];
	for (const item of additions) {
		const trimmedName = item.name.trim().slice(0, 200);
		const quantity = Number(item.quantity);
		const trimmedUnit = item.unit.trim();
		if (!trimmedName || !Number.isFinite(quantity) || !(quantity > 0) || !trimmedUnit) continue;
		const normalizedName = normalizeName(trimmedName);
		if (!normalizedName) continue;
		const unit = unitInfo(trimmedUnit);
		const category = item.category?.trim().slice(0, 100) || 'Pantry';
		const expires = item.expires?.trim().slice(0, 50);
		if (expires) {
			datedAdditions.push({
				name: trimmedName,
				unit,
				quantityBase: quantity * unit.factor,
				category,
				expires
			});
			continue;
		}
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
	const allocateId = () => {
		const baseId = createId();
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
		usedIds.add(id);
		return id;
	};

	for (const [key, bucket] of buckets) {
		const [normalizedName] = key.split('\u0000');
		const destination = result.find(
			(item) =>
				!item.sample &&
				normalizeName(item.name) === normalizedName &&
				unitInfo(item.unit).dimension === bucket.unit.dimension &&
				!item.expires?.trim()
		);
		if (destination) {
			const baseline = Number.isFinite(destination.quantity)
				? Math.max(0, destination.quantity)
				: 0;
			destination.quantity = Math.min(
				1_000_000,
				roundPantryQuantity(baseline + bucket.quantityBase / unitInfo(destination.unit).factor)
			);
			if (!destination.category?.trim()) {
				destination.category = bucket.category || 'Pantry';
			}
			continue;
		}
		if (result.length >= 1_000) continue;

		result.push({
			id: allocateId(),
			name: bucket.name,
			quantity: Math.min(1_000_000, roundPantryQuantity(bucket.quantityBase / bucket.unit.factor)),
			unit: bucket.unit.display.slice(0, 40),
			category: bucket.category.slice(0, 100) || 'Pantry'
		});
	}

	for (const item of datedAdditions) {
		if (result.length >= 1_000) break;
		result.push({
			id: allocateId(),
			name: item.name,
			quantity: Math.min(1_000_000, roundPantryQuantity(item.quantityBase / item.unit.factor)),
			unit: item.unit.display.slice(0, 40),
			category: item.category.slice(0, 100) || 'Pantry',
			expires: item.expires
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
				category: item.category
			})),
		createId
	);
}

/**
 * Add pantry entries, retire matching checked shopping rows per scope up to non-expired
 * added quantities, and refresh active weekly scopes once.
 */
export function addPantryItems(
	state: AppState,
	additions: PantryAddition[],
	now: Date = new Date(),
	createId: () => string = () => globalThis.crypto.randomUUID()
): AppState {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const existingKeys = new Set(
		state.pantry
			.filter((item) => !item.sample && !item.expires?.trim())
			.map((item) => bucketKey(item.name, item.unit))
	);
	let lotCount = state.pantry.length;
	const accepted: PantryAddition[] = [];
	for (const item of additions) {
		const name = item.name.trim().slice(0, 200);
		const quantity = Number(item.quantity);
		const unit = item.unit.trim().slice(0, 40);
		if (!name || !unit || !Number.isFinite(quantity) || !(quantity > 0)) continue;
		const normalized = normalizeName(name);
		if (!normalized) continue;
		const hasExpiry = Boolean(item.expires?.trim());
		const key = `${normalized}\u0000${unitInfo(unit).dimension}`;
		if (hasExpiry || !existingKeys.has(key)) {
			if (lotCount >= 1_000) continue;
			if (!hasExpiry) existingKeys.add(key);
			lotCount += 1;
		}
		accepted.push({
			name,
			quantity: Math.min(1_000_000, quantity),
			unit,
			category: item.category,
			expires: item.expires
		});
	}
	const weeks = activeWeeklyScopes(state.shopping);
	const pantry = mergePantryAdditions(state.pantry, accepted, createId);
	let shopping = retireCheckedShoppingItems(
		state.shopping,
		accepted.map((item) => ({
			name: item.name,
			quantity: Number(item.quantity),
			unit: item.unit,
			expires: item.expires
		})),
		safeNow
	);
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
	const existingKeys = new Set(
		state.pantry
			.filter((item) => !item.sample && !item.expires?.trim())
			.map((item) => bucketKey(item.name, item.unit))
	);
	let lotCount = state.pantry.length;
	const accepted: ShoppingItem[] = [];
	const acceptedIds = new Set<string>();
	for (const item of checked) {
		const name = item.name.trim().slice(0, 200);
		const unit = item.unit.trim().slice(0, 40);
		if (!name || !unit || !Number.isFinite(item.quantity) || !(item.quantity > 0)) continue;
		const normalized = normalizeName(name);
		if (!normalized) continue;
		const key = `${normalized}\u0000${unitInfo(unit).dimension}`;
		if (!existingKeys.has(key)) {
			if (lotCount >= 1_000) continue;
			existingKeys.add(key);
			lotCount += 1;
		}
		accepted.push({
			...item,
			name,
			unit,
			quantity: Math.min(1_000_000, item.quantity)
		});
		acceptedIds.add(item.id);
	}
	const weeks = activeWeeklyScopes(state.shopping);
	const pantry = transferPurchasedItemsToPantry(state.pantry, accepted, createId);
	let shopping = state.shopping.filter((item) => !acceptedIds.has(item.id));
	for (const week of weeks) {
		shopping = refreshWeekShopping({ ...state, pantry, shopping }, week, safeNow);
	}
	return { ...state, pantry, shopping };
}

/** Move selected or all depleted pantry items into the shopping list without duplicating compatible unchecked entries. */
export function restockDepletedPantryItems(
	pantry: Ingredient[],
	shopping: ShoppingItem[],
	selectedIds?: Iterable<string>,
	createId: () => string = () => globalThis.crypto.randomUUID()
): { pantry: Ingredient[]; shopping: ShoppingItem[]; restockedCount: number; addedCount: number } {
	const selection = selectedIds ? new Set(selectedIds) : undefined;
	const nextPantry: Ingredient[] = [];
	const uncheckedShopping = shopping.filter((item) => !item.checked).map((item) => ({ ...item }));
	const checkedShopping = shopping.filter((item) => item.checked).map((item) => ({ ...item }));
	const addedShopping: ShoppingItem[] = [];
	const usedIds = new Set(shopping.map((item) => item.id));
	const uncheckedKeys = new Set<string>();
	for (const entry of uncheckedShopping) {
		if (!entry.name.trim()) continue;
		uncheckedKeys.add(bucketKey(entry.name, entry.unit.trim() || 'piece'));
	}

	let restockedCount = 0;
	let addedCount = 0;
	for (const item of pantry) {
		const isSelected = !selection || selection.has(item.id);
		const isDepleted = Number.isFinite(item.quantity) && item.quantity <= 0;
		const name = item.name.trim().slice(0, 200);
		if (!isSelected || !isDepleted || !name) {
			nextPantry.push({ ...item });
			continue;
		}

		const unit = item.unit.trim().slice(0, 40) || 'piece';
		const key = bucketKey(name, unit);
		if (!uncheckedKeys.has(key)) {
			if (
				uncheckedShopping.length + checkedShopping.length + addedShopping.length >=
				MAX_SHOPPING_ITEMS
			) {
				nextPantry.push({ ...item });
				continue;
			}
			uncheckedKeys.add(key);
			const baseId = createId();
			let id = baseId;
			let suffix = 2;
			while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
			usedIds.add(id);
			addedShopping.push({
				id,
				name,
				quantity: 1,
				unit,
				checked: false
			});
			addedCount++;
		}
		restockedCount++;
	}

	return {
		pantry: nextPantry,
		shopping: [...uncheckedShopping, ...addedShopping, ...checkedShopping],
		restockedCount,
		addedCount
	};
}

function recipeForMeal(state: AppState, meal: Meal): Recipe | undefined {
	return state.recipes.find((recipe) => recipe.id === meal.recipeId);
}

function consumePantry(
	pantry: Ingredient[],
	recipe: Recipe,
	servings: number,
	now: Date
): { pantry: Ingredient[]; uncoveredByBucket: Map<string, number> } {
	return consumeRecipeFromPantry(pantry, recipe, servings, now);
}

/**
 * Mark a planned meal complete. When `options.deductPantry` is opted in (`true`), consumes
 * non-expired pantry stock first (soonest-expiry order) and retires only any uncovered demand
 * in place from the meal's `week:<startDate>` checked rows. When `options.deductPantry` is
 * `false` (e.g., takeout, dining out, or leaving stock untouched), both pantry quantities and
 * weekly checked purchases stay intact so unconsumed groceries continue to cover later planned
 * meals when active weekly scopes refresh.
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
	const meals = state.meals.map((meal) => {
		if (meal.id !== mealId) return meal;
		const { sample: _sample, ...userMeal } = meal;
		return { ...userMeal, completedAt: safeNow.toISOString(), leftoverServings };
	});

	const weekStart = weekStartForDate(target.date);
	const weekSourceKey = weekStart ? `week:${weekStart}` : undefined;
	const hadWeekScope = weekSourceKey
		? state.shopping.some((item) => item.sourceKey === weekSourceKey)
		: false;

	let pantry = state.pantry;
	let shopping = state.shopping;

	// Intentionally gate weekly checked-row retirement alongside pantry deduction:
	// checked rows represent unconsumed groceries on hand, and uncovered demand is only
	// defined after deducting pantry stock. When deductPantry is false, neither pantry
	// stock nor checked groceries were consumed by this meal.
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

const seedPantryById = new Map(seedPantry.map((item) => [item.id, item]));
const seedSavedRecipesById = new Map(
	seedRecipes.filter((recipe) => recipe.saved).map((recipe) => [recipe.id, recipe])
);

/** Check whether the kitchen currently contains any untouched sample staples, meals, or bookmarks. */
export function hasSampleData(
	state: Pick<AppState, 'pantry' | 'meals' | 'recipes'>,
	hasSampleMeal?: boolean
): boolean {
	return (
		state.pantry.some((item) => Boolean(item.sample)) ||
		(hasSampleMeal ?? state.meals.some((meal) => Boolean(meal.sample))) ||
		state.recipes.some((recipe) => Boolean(recipe.saved && recipe.sampleSaved))
	);
}

/** Promote an edited sample pantry ingredient to user-owned stock. */
export function promoteSampleIngredient(item: Ingredient): Ingredient {
	const { sample: _sample, ...promoted } = item;
	return promoted;
}

/** Promote an edited sample meal entry to user-owned status. */
export function promoteSampleMeal(meal: Meal): Meal {
	const { sample: _sample, ...promoted } = meal;
	return promoted;
}

/** Promote an edited or toggled recipe bookmark out of sample status. */
export function promoteSampleBookmark(recipe: Recipe): Recipe {
	const { sampleSaved: _sampleSaved, ...promoted } = recipe;
	return promoted;
}

function stableDataSnapshot(value: unknown): string | undefined {
	return JSON.stringify(value, (_key, entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
		return Object.fromEntries(
			Object.entries(entry)
				.filter(([, item]) => item !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
		);
	});
}

/**
 * Backfill only exact legacy pantry and bookmark seed records. Older guest snapshots have no
 * provenance for planned meals, so their IDs and dates cannot safely distinguish a starter from
 * a user-rescheduled meal.
 */
export function backfillSampleData(state: AppState): AppState {
	if (
		!state ||
		typeof state !== 'object' ||
		!Array.isArray(state.pantry) ||
		!Array.isArray(state.meals) ||
		!Array.isArray(state.recipes)
	) {
		return state;
	}
	const alreadyTagged =
		state.pantry.some((item) => item?.sample !== undefined) ||
		state.meals.some((meal) => meal?.sample !== undefined) ||
		state.recipes.some((recipe) => recipe?.sampleSaved !== undefined);
	if (alreadyTagged) return state;

	const pantry = state.pantry.map((item) => {
		const seed = seedPantryById.get(item.id);
		if (seed && stableDataSnapshot(item) === stableDataSnapshot(seed)) {
			return { ...item, sample: true };
		}
		return { ...item };
	});

	const meals = state.meals.map((meal) => ({ ...meal }));

	const recipes = state.recipes.map((recipe) => {
		const seed = seedSavedRecipesById.get(recipe.id);
		if (seed && stableDataSnapshot(recipe) === stableDataSnapshot(seed)) {
			return { ...recipe, sampleSaved: true };
		}
		return { ...recipe };
	});

	return { ...state, pantry, meals, recipes };
}

function weekEndKey(startKey: string): string | undefined {
	const parsed = parseCalendarDate(startKey);
	if (!parsed) return undefined;
	const end = new Date(0);
	end.setFullYear(parsed.year, parsed.month, parsed.day + 6);
	end.setHours(12, 0, 0, 0);
	return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
}

/**
 * Remove untouched sample staples, meals, and bookmarks while keeping all user-added or
 * promoted kitchen data and refreshing generated weekly shopping lists.
 */
export function clearSampleData(state: AppState, now: Date = new Date()): AppState {
	const pantry = state.pantry.filter((item) => !item.sample).map((item) => ({ ...item }));
	const meals = state.meals.filter((meal) => !meal.sample).map((meal) => ({ ...meal }));
	const recipes = state.recipes.map((recipe) => {
		const { sampleSaved, ...rest } = recipe;
		return sampleSaved ? { ...rest, saved: false } : { ...rest };
	});

	let shopping = state.shopping.map((item) => ({ ...item }));
	const weeks = new Set(
		shopping.flatMap((item) => item.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1] ?? [])
	);
	for (const startKey of weeks) {
		const endKey = weekEndKey(startKey);
		if (!endKey) continue;
		const weekMeals = meals.filter(
			(meal) => !meal.completedAt && meal.date >= startKey && meal.date <= endKey
		);
		const additions = buildShoppingList(recipes, pantry, weekMeals, now);
		shopping = reconcileShoppingList(shopping, additions, `week:${startKey}`);
	}

	return {
		...state,
		pantry,
		recipes,
		meals,
		shopping,
		preferences: structuredClone(state.preferences)
	};
}
