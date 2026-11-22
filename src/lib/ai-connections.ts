import type { Ingredient, Preferences, Recipe } from './types.ts';

export function formatRetryWait(seconds: number): string {
	const safeSeconds = Math.max(1, Math.ceil(seconds));
	if (safeSeconds >= 60) {
		const minutes = Math.ceil(safeSeconds / 60);
		return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	}
	return `${safeSeconds} second${safeSeconds === 1 ? '' : 's'}`;
}

export function parseRetryAfter(
	value: string | null | undefined,
	now = Date.now()
): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? Math.max(1, Math.ceil(parsed)) : undefined;
	}
	const dateMs = Date.parse(trimmed);
	if (Number.isFinite(dateMs)) {
		return Math.max(1, Math.ceil((dateMs - now) / 1000));
	}
	return undefined;
}

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

export type ResolvedConnectionModel = {
	provider?: ConnectionProvider;
	models: ConnectionModel[];
	selectedModel?: ConnectionModel;
	catalogLoaded: boolean;
	modelOmitted: boolean;
};

export function resolveConnectionModel(
	preferences: Pick<Preferences, 'provider' | 'model'>,
	providers: ConnectionProvider[],
	accountModels: ConnectionModel[]
): ResolvedConnectionModel {
	const subscription = preferences.provider === 'chatgpt';
	const provider = subscription
		? undefined
		: providers.find((item) => item.id === preferences.provider);
	const models = subscription ? accountModels : (provider?.models ?? []);
	const catalogLoaded = subscription ? accountModels.length > 0 : providers.length > 0;
	const modelId = preferences.model.trim();
	const selectedModel = modelId ? models.find((item) => item.id === modelId) : undefined;
	return {
		provider,
		models,
		selectedModel,
		catalogLoaded,
		modelOmitted: Boolean(catalogLoaded && modelId && !selectedModel)
	};
}

export function buildAIPayload(
	action: string,
	options: {
		preferences: Preferences;
		apiKey: string;
		selectedModel?: ConnectionModel;
		pantry?: Ingredient[];
		recipes?: Recipe[];
		prompt?: string;
		extra?: Record<string, unknown>;
	}
): Record<string, unknown> {
	const { preferences, apiKey, selectedModel, extra = {} } = options;
	if (action === 'search') {
		return { action, ...extra };
	}
	const reasoning = preferences.reasoning ?? (selectedModel?.reasoning ? {} : undefined);
	const base: Record<string, unknown> = {
		action,
		...(preferences.provider === 'chatgpt'
			? { connectionId: preferences.chatgptAccountId }
			: { apiKey }),
		provider: preferences.provider,
		model: preferences.model,
		...(reasoning !== undefined ? { reasoning } : {})
	};
	if (action === 'generate') {
		const trimmedPrompt = options.prompt?.trim();
		return {
			...base,
			pantry: options.pantry ?? [],
			preferences,
			recipes: (options.recipes ?? []).filter((recipe) => recipe.rating).slice(0, 30),
			...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
			...extra
		};
	}
	return {
		...base,
		...extra
	};
}

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
