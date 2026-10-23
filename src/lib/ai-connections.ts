export type ReasoningSettings = { effort?: string; enabled?: boolean; budgetTokens?: number };
export type ConnectionModel = {
	id: string;
	name: string;
	vision: boolean;
	reasoning?: { efforts: string[]; toggle: boolean; budgetMin?: number; budgetMax?: number };
};
export type ConnectionProvider = {
	id: string;
	name: string;
	models: ConnectionModel[];
	supported: boolean;
	apiKeyHint?: string;
	documentation?: string;
};

export function modelMetadata(value: unknown): Pick<ConnectionModel, 'reasoning'> {
	if (!value || typeof value !== 'object') return {};
	const source = value as Record<string, any>;
	if (!source.reasoning || !Array.isArray(source.reasoning_options)) return {};
	const options = source.reasoning_options;
	const effort = options.find((o: any) => o?.type === 'effort');
	const budget = options.find((o: any) => o?.type === 'budget_tokens');
	const efforts = Array.isArray(effort?.values)
		? effort.values.filter(
				(v: unknown): v is string => typeof v === 'string' && /^[a-z_]{1,24}$/.test(v)
			)
		: [];
	const toggle = options.some((o: any) => o?.type === 'toggle');
	if (!efforts.length && !toggle && !budget) return {};
	return {
		reasoning: {
			efforts,
			toggle,
			...(budget
				? {
						budgetMin: Math.max(0, Number(budget.min) || 0),
						budgetMax: Math.min(32_768, Number(budget.max) || 32_768)
					}
				: {})
		}
	};
}

export function searchConnections(providers: ConnectionProvider[], query: string) {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const popular = ['openai', 'anthropic', 'google', 'openrouter'];
	const priority = (id: string) => (popular.includes(id) ? popular.indexOf(id) : popular.length);
	return providers
		.filter((provider) =>
			terms.every(
				(term) =>
					`${provider.name} ${provider.id}`.toLowerCase().includes(term) ||
					provider.models.some((model) => `${model.name} ${model.id}`.toLowerCase().includes(term))
			)
		)
		.sort(
			(a, b) =>
				Number(b.supported) - Number(a.supported) ||
				(!terms.length ? priority(a.id) - priority(b.id) : 0) ||
				a.name.localeCompare(b.name)
		);
}

export function searchModels(models: ConnectionModel[], query: string) {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((model) =>
		terms.every((term) => `${model.name} ${model.id}`.toLowerCase().includes(term))
	);
}
