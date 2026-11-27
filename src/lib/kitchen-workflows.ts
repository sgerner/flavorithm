import type { AppState, Ingredient, Meal, PantryDeduction, Recipe, ShoppingItem } from './types.ts';
import {
	buildShoppingList,
	dateOrdinal,
	normalizeName,
	parseCalendarDate,
	resolveShoppingQuantity,
	roundShoppingQuantity,
	unitInfo,
	type UnitInfo
} from './domain.ts';
import { MAX_SHOPPING_QUANTITY } from './recipe-draft.ts';
import { hasZeroNutrition } from './recipe-collection.ts';
import { seedPantry, seedRecipes } from './data.ts';
export {
	normalizeName,
	normalizeName as normalizeIngredientName,
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

function parseCalendarKey(value: string): { year: number; month: number; day: number } | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]) - 1;
	const day = Number(match[3]);
	const parsed = new Date(0);
	parsed.setUTCFullYear(year, month, day);
	parsed.setUTCHours(0, 0, 0, 0);
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() !== month ||
		parsed.getUTCDate() !== day
	)
		return undefined;
	return { year, month, day };
}

function formatCalendarKey(date: { year: number; month: number; day: number }): string {
	return `${date.year}-${String(date.month + 1).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function mondayKeyForParts(parts: { year: number; month: number; day: number }): string {
	const day = new Date(0);
	day.setUTCFullYear(parts.year, parts.month, parts.day);
	day.setUTCHours(12, 0, 0, 0);
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return formatCalendarKey({
		year: day.getUTCFullYear(),
		month: day.getUTCMonth(),
		day: day.getUTCDate()
	});
}

/** Return the Monday YYYY-MM-DD calendar key for a local date string or Date instance. */
export function weekStartForDate(value: string | Date | undefined): string {
	if (!value) return '';
	if (typeof value === 'string') {
		const parsed = parseCalendarKey(value);
		if (!parsed) return value;
		return mondayKeyForParts(parsed);
	}
	const parts = calendarDate(value);
	if (!parts) return '';
	return mondayKeyForParts(parts);
}

function weekDatesForStart(startDate: string): Set<string> | undefined {
	const parsed = parseCalendarKey(startDate);
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
		if (match && parseCalendarKey(match[1])) weeks.add(match[1]);
	}
	return [...weeks];
}

function refreshWeekShoppingItems(
	state: Pick<AppState, 'recipes' | 'pantry' | 'meals' | 'shopping'>,
	startDate: string | undefined,
	now: Date = new Date()
): ShoppingItem[] | undefined {
	if (!startDate) return undefined;
	const dates = weekDatesForStart(startDate);
	if (!dates) return undefined;
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const meals = state.meals.filter((meal) => !meal.completedAt && dates.has(meal.date));
	const additions = buildShoppingList(state.recipes, state.pantry, meals, safeNow);
	return reconcileShoppingList(state.shopping, additions, `week:${startDate}`);
}

/** Refresh one weekly shopping-list scope from incomplete planned meals in that 7-day window. */
export function refreshWeekShopping(
	state: AppState,
	startDate: string | undefined,
	now: Date = new Date()
): AppState {
	const shopping = refreshWeekShoppingItems(state, startDate, now);
	return shopping ? { ...state, shopping } : state;
}

function refreshWeeks(state: AppState, weekStarts: Iterable<string>, now: Date): AppState {
	let next = state;
	for (const startDate of new Set(weekStarts)) {
		next = refreshWeekShopping(next, startDate, now);
	}
	return next;
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
	return refreshWeekShoppingItems({ ...state, shopping }, match[1], now) ?? shopping;
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
		{ name: string; unit: ReturnType<typeof unitInfo>; quantityBase: number; category?: string }
	>();
	for (const item of purchases) {
		if (
			!item.checked ||
			!item.name.trim() ||
			!Number.isFinite(item.quantity) ||
			!(item.quantity > 0) ||
			!item.unit.trim()
		)
			continue;
		const normalizedName = normalizeName(item.name);
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const bucket = buckets.get(key) ?? {
			name: item.name.trim().slice(0, 200),
			unit,
			quantityBase: 0
		};
		bucket.quantityBase += item.quantity * unit.factor;
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
	const shopping = retireCheckedShoppingItems(state.shopping, additions, safeNow);
	return refreshWeeks({ ...state, pantry, shopping }, weeks, safeNow);
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
		const key = bucketKey(name, unit);
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
	const shopping = state.shopping.filter((item) => !acceptedIds.has(item.id));
	return refreshWeeks({ ...state, pantry, shopping }, weeks, safeNow);
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
): { pantry: Ingredient[]; deductions: PantryDeduction[]; uncoveredByBucket: Map<string, number> } {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const remaining = pantry.map((item) => ({ ...item }));
	const uncoveredByBucket = new Map<string, number>();
	if (!Number.isFinite(servings) || !(servings > 0)) {
		return { pantry: remaining, deductions: [], uncoveredByBucket };
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

		if (need > 0) {
			const key = bucketKey(ingredient.name, ingredient.unit);
			const unit = unitInfo(ingredient.unit);
			uncoveredByBucket.set(key, (uncoveredByBucket.get(key) ?? 0) + need * unit.factor);
		}
	}

	const deductions: PantryDeduction[] = [];
	for (let index = 0; index < pantry.length; index += 1) {
		const before = pantry[index];
		const after = remaining[index];
		const deducted = roundPantryQuantity(before.quantity - after.quantity);
		if (Number.isFinite(deducted) && deducted > 0) {
			deductions.push({
				pantryId: before.id,
				name: before.name,
				quantity: deducted,
				unit: before.unit
			});
		}
	}

	return { pantry: remaining, deductions, uncoveredByBucket };
}

/** Clamp leftover servings between 0 and the meal's valid serving count. */
export function clampLeftoverServings(
	leftoverServings: number | undefined,
	servings: number
): number {
	const servingsLimit = Number.isFinite(servings) ? Math.max(0, servings) : 0;
	return Number.isFinite(leftoverServings)
		? roundQuantity(Math.min(servingsLimit, Math.max(0, leftoverServings as number)))
		: 0;
}

function affectedWeekStarts(shopping: ShoppingItem[], dates: Iterable<string>): string[] {
	const targetDates = [...new Set([...dates].filter((date) => Boolean(parseCalendarKey(date))))];
	const weeks = new Set<string>();
	for (const date of targetDates) {
		const start = weekStartForDate(date);
		if (parseCalendarKey(start)) weeks.add(start);
	}
	for (const existingWeek of activeWeeklyScopes(shopping)) {
		const window = weekDatesForStart(existingWeek);
		if (window && targetDates.some((date) => window.has(date))) weeks.add(existingWeek);
	}
	return [...weeks];
}

/**
 * Refresh a single-recipe shopping scope when that recipe already has generated items in the list,
 * scaling from the recipe's current servings baseline while preserving manual and checked rows.
 */
export function refreshRecipeShopping(
	state: AppState,
	recipeId: string,
	now: Date = new Date(),
	options?: { force?: boolean }
): AppState {
	const sourceKey = `recipe:${recipeId}`;
	if (!options?.force && !state.shopping.some((item) => item.sourceKey === sourceKey)) return state;
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

const NUTRITION_KEYS: (keyof Recipe['nutrition'])[] = [
	'calories',
	'fat',
	'saturatedFat',
	'sodium',
	'carbs',
	'fiber',
	'sugar',
	'protein'
];

/**
 * Insert or update a recipe, track provenance, nutrition staleness, and ratings, and refresh
 * affected weekly and existing single-recipe shopping scopes.
 */
export function upsertRecipe(state: AppState, recipe: Recipe, now: Date = new Date()): AppState {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const previous = state.recipes.find((item) => item.id === recipe.id);
	const updated = promoteSampleBookmark(cloneRecipe(recipe));
	if (previous?.provenance === 'manual') updated.provenance = 'manual';
	else if (updated.provenance === undefined && previous?.provenance) {
		updated.provenance = previous.provenance;
	}
	const nutritionNeedsRefresh = recipeNeedsNutritionRefresh(previous, updated);
	const nutritionChanged = Boolean(
		previous && NUTRITION_KEYS.some((key) => previous.nutrition[key] !== updated.nutrition[key])
	);
	const zeroNutrition = hasZeroNutrition(updated.nutrition);
	if (nutritionNeedsRefresh) {
		updated.nutritionStale = true;
	} else if (updated.provenance === 'manual' && zeroNutrition) {
		updated.nutritionStale = true;
	} else if (nutritionChanged && !zeroNutrition) {
		updated.nutritionStale = false;
	} else if (previous?.nutritionStale) {
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
	const shopping = state.shopping.filter(
		(item) => item.sourceKey !== `recipe:${recipeId}` || item.checked
	);
	let preferences = state.preferences;
	if (state.preferences.ratings && recipeId in state.preferences.ratings) {
		const ratings = { ...state.preferences.ratings };
		delete ratings[recipeId];
		preferences = { ...state.preferences, ratings };
	}
	return refreshWeeks({ ...state, recipes, meals, shopping, preferences }, weeksToRefresh, safeNow);
}

/**
 * Add or update a meal (preserving completion metadata on already-cooked meals, clamping
 * leftover updates, and stripping completion fields on uncompleted meals) and refresh both
 * previous and target weeks when planned meals change.
 */
export function upsertMeal(
	state: AppState,
	meal: Meal,
	now: Date = new Date(),
	options?: { preserveSample?: boolean }
): AppState {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const previous = state.meals.find((item) => item.id === meal.id);
	const sourceMeal = options?.preserveSample ? meal : promoteSampleMeal(meal);
	const {
		completedAt: _completedAt,
		leftoverServings: requestedLeftovers,
		pantryDeductions: _pantryDeductions,
		...baseMeal
	} = sourceMeal;
	if (previous?.completedAt) {
		const rawLeftovers = requestedLeftovers ?? previous.leftoverServings;
		const leftoverServings =
			rawLeftovers === undefined || !Number.isFinite(rawLeftovers)
				? undefined
				: clampLeftoverServings(rawLeftovers, baseMeal.servings);
		const nextMeal: Meal = {
			...baseMeal,
			completedAt: previous.completedAt,
			...(leftoverServings !== undefined ? { leftoverServings } : {}),
			...(previous.pantryDeductions ? { pantryDeductions: previous.pantryDeductions } : {})
		};
		const meals = state.meals.map((item) => (item.id === nextMeal.id ? nextMeal : item));
		return { ...state, meals };
	}
	const nextMeal: Meal = { ...baseMeal };
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

/**
 * Mark a planned meal complete and refresh affected weekly shopping scopes. When
 * `options.deductPantry` is opted in (`true`), consumes non-expired pantry stock first
 * (soonest-expiry order) and retires only any uncovered demand in place from the meal's
 * `week:<startDate>` checked rows, refreshing active weekly scopes for updated pantry stock.
 * When `options.deductPantry` is `false` (e.g., takeout, dining out, or leaving stock
 * untouched), both pantry quantities and weekly checked purchases stay intact so unconsumed
 * groceries continue to cover later planned meals when weekly scopes refresh.
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
	const leftoverServings = clampLeftoverServings(options.leftoverServings, target.servings);

	const weekStart = parseCalendarKey(target.date) ? weekStartForDate(target.date) : '';
	const weekSourceKey = weekStart ? `week:${weekStart}` : undefined;
	const weeksToRefresh = [
		...affectedWeekStarts(state.shopping, [target.date]),
		...(options.deductPantry && recipe ? activeWeeklyScopes(state.shopping) : [])
	];

	let pantry = state.pantry;
	let shopping = state.shopping;
	let deductions: PantryDeduction[] = [];

	// Intentionally gate weekly checked-row retirement alongside pantry deduction:
	// checked rows represent unconsumed groceries on hand, and uncovered demand is only
	// defined after deducting pantry stock. When deductPantry is false, neither pantry
	// stock nor checked groceries were consumed by this meal.
	if (options.deductPantry && recipe) {
		const consumed = consumePantry(state.pantry, recipe, target.servings, safeNow);
		pantry = consumed.pantry;
		deductions = consumed.deductions;
		if (weekSourceKey && consumed.uncoveredByBucket.size > 0) {
			const weekBudget = new Map(consumed.uncoveredByBucket);
			shopping = retireCheckedByScopeBudget(shopping, (scopeKey) =>
				scopeKey === weekSourceKey ? weekBudget : undefined
			);
		}
	}

	const meals = state.meals.map((meal) => {
		if (meal.id !== mealId) return meal;
		const { sample: _sample, ...userMeal } = meal;
		return {
			...userMeal,
			completedAt: safeNow.toISOString(),
			leftoverServings,
			...(deductions.length ? { pantryDeductions: deductions } : {})
		};
	});

	return refreshWeeks({ ...state, meals, pantry, shopping }, weeksToRefresh, safeNow);
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
