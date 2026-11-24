import type { Preferences, User } from './types.ts';

export const SCAN_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const SCAN_PHOTO_ACCEPT = SCAN_PHOTO_MIME_TYPES.join(',');

export function isSupportedScanPhotoType(mimeType: string): boolean {
	return (SCAN_PHOTO_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

export type GenerateGuestFilters = Partial<Pick<Preferences, 'maxTime' | 'diet' | 'allergies'>>;

export type PendingAIContinuation =
	| { kind: 'import' }
	| { kind: 'generate'; prompt: string; guestFilters?: GenerateGuestFilters }
	| { kind: 'butler'; prompt: string }
	| { kind: 'scan'; returnToPantryModal?: boolean }
	| { kind: 'nutrition'; recipeId: string; servings?: number };

export type ChatGPTConnectionStatus = {
	connected: boolean;
	planEnabled: boolean;
};

export function hasAIConnection(args: {
	user: User | null;
	preferences: Pick<Preferences, 'provider' | 'model'>;
	apiKey: string;
	activeChatGPTAccount?: ChatGPTConnectionStatus;
}): boolean {
	if (!args.user) return false;
	const isPlan = args.preferences.provider === 'chatgpt';
	if (
		(isPlan
			? !args.activeChatGPTAccount?.connected || !args.activeChatGPTAccount.planEnabled
			: !args.apiKey) ||
		!args.preferences.model
	) {
		return false;
	}
	return true;
}

export function captureGenerateGuestFilters(
	current: Pick<Preferences, 'maxTime' | 'diet' | 'allergies'>,
	defaults: Pick<Preferences, 'maxTime' | 'diet' | 'allergies'>
): GenerateGuestFilters | undefined {
	const filters: GenerateGuestFilters = {};
	if (current.maxTime !== defaults.maxTime) filters.maxTime = current.maxTime;
	if (current.diet !== defaults.diet) filters.diet = current.diet;
	if (current.allergies !== defaults.allergies) filters.allergies = current.allergies;
	return Object.keys(filters).length > 0 ? filters : undefined;
}

export function applyGenerateGuestFilters<
	T extends Pick<Preferences, 'maxTime' | 'diet' | 'allergies'>
>(target: T, filters?: GenerateGuestFilters): T {
	if (!filters) return target;
	if (filters.maxTime !== undefined) target.maxTime = filters.maxTime;
	if (filters.diet !== undefined) target.diet = filters.diet;
	if (filters.allergies !== undefined) target.allergies = filters.allergies;
	return target;
}

export type PostSetupResolution = 'settings' | 'resume' | 'none';

export function resolvePostSetupAction(
	continuation: PendingAIContinuation | null,
	aiReady: boolean
): PostSetupResolution {
	if (!continuation) return 'none';
	return aiReady ? 'resume' : 'settings';
}

export function shouldOpenPantryOnScanError(args: {
	aborted: boolean;
	modal: string;
	page: string;
	hasOverlay: boolean;
	fromContinuation: boolean;
}): boolean {
	if (args.aborted) return false;
	if (args.modal === 'pantry') return true;
	if (args.modal || args.hasOverlay) return false;
	return args.page === 'pantry' || args.fromContinuation;
}

export type ButlerOwnerSnapshot<TMessage = unknown, TDraftRecipe = unknown> = {
	messages: TMessage[];
	recipeDrafts: TDraftRecipe[];
	draft: string;
	error: string;
	failedPrompt: string;
	applying: string;
};

export function isGuestButlerOwner(owner: string): boolean {
	return owner === 'guest' || owner.startsWith('guest:');
}

export function isSignedInButlerOwner(owner: string): boolean {
	return Boolean(owner) && !isGuestButlerOwner(owner);
}

export function transitionButlerOwner<TMessage = unknown, TDraftRecipe = unknown>(
	previousOwner: string,
	nextOwner: string,
	current: ButlerOwnerSnapshot<TMessage, TDraftRecipe>
): ButlerOwnerSnapshot<TMessage, TDraftRecipe> {
	const preserveGuestPrompt = isGuestButlerOwner(previousOwner) && isSignedInButlerOwner(nextOwner);
	const pendingPrompt = preserveGuestPrompt
		? current.draft.trim()
			? current.draft
			: current.failedPrompt
		: '';
	return {
		messages: [],
		recipeDrafts: [],
		draft: pendingPrompt,
		error: '',
		failedPrompt: '',
		applying: ''
	};
}
