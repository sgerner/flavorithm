export type PickerOption = {
	id: string;
	label: string;
	detail?: string;
	searchText?: string;
	disabled?: boolean;
	searchOnly?: boolean;
};

export type PickerState = {
	open: boolean;
	filtering: boolean;
	query: string;
	active: number;
};

export const PICKER_VISIBLE_LIMIT = 80;

export function createPickerState(): PickerState {
	return { open: false, filtering: false, query: '', active: -1 };
}

export function focusPickerState(): PickerState {
	return { open: true, filtering: false, query: '', active: -1 };
}

export function inputPickerState(query: string): PickerState {
	return { open: true, filtering: true, query, active: -1 };
}

export function closePickerState(): PickerState {
	return { open: false, filtering: false, query: '', active: -1 };
}

export function escapePickerState(state: Pick<PickerState, 'open' | 'filtering'>): {
	state: PickerState;
	handled: boolean;
} {
	if (!state.open && !state.filtering) {
		return { state: createPickerState(), handled: false };
	}
	return { state: closePickerState(), handled: true };
}

export function resolvePickerValue({
	options,
	value = '',
	fallback = '',
	query = '',
	filtering = false
}: {
	options: PickerOption[];
	value?: string;
	fallback?: string;
	query?: string;
	filtering?: boolean;
}): string {
	if (filtering) return query;
	return options.find((option) => option.id === value)?.label || fallback;
}

export function filterPickerOptions(
	options: PickerOption[],
	query: string,
	filtering = true
): PickerOption[] {
	const effectiveQuery = filtering ? query : '';
	const terms = effectiveQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return options
		.filter(
			(option) =>
				(!option.searchOnly || terms.length > 0) &&
				terms.every((term) =>
					`${option.label} ${option.detail || ''} ${option.searchText || ''}`
						.toLowerCase()
						.includes(term)
				)
		)
		.sort((a, b) =>
			terms.length
				? Number(terms.every((term) => `${b.label} ${b.id}`.toLowerCase().includes(term))) -
					Number(terms.every((term) => `${a.label} ${a.id}`.toLowerCase().includes(term)))
				: 0
		);
}

export function stepPickerActive(
	visible: PickerOption[],
	active: number,
	key: 'ArrowDown' | 'ArrowUp'
): number {
	if (!visible.length) return -1;
	const step = key === 'ArrowDown' ? 1 : -1;
	let candidate =
		active < 0 || active >= visible.length
			? step > 0
				? 0
				: visible.length - 1
			: (active + step + visible.length) % visible.length;
	for (let count = 0; count < visible.length; count++) {
		if (!visible[candidate]?.disabled) return candidate;
		candidate = (candidate + step + visible.length) % visible.length;
	}
	return -1;
}

export function activeOptionId(
	id: string,
	open: boolean,
	disabled: boolean,
	visible: PickerOption[],
	active: number
): string | undefined {
	if (!open || disabled || active < 0) return undefined;
	const option = visible[active];
	if (!option || option.disabled) return undefined;
	return `${id}-option-${active}`;
}
