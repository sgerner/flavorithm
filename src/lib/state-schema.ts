import { z } from 'zod';
import { COVER_PATH } from '#lib/cover-upload.ts';
import { MAX_RECIPES } from '#lib/recipe-collection.ts';
import type { AppState } from '#lib/types.ts';

function isPublicHttpsUrl(value: string): boolean {
	if (!value) return true;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch {
		return false;
	}
}

export const publicUrlSchema = z
	.string()
	.max(4_000)
	.refine(isPublicHttpsUrl, 'Only public HTTPS URLs are allowed');

export const nutritionSchema = z.object({
	calories: z.number().min(0).max(1_000_000),
	fat: z.number().min(0).max(1_000_000),
	saturatedFat: z.number().min(0).max(1_000_000),
	sodium: z.number().min(0).max(1_000_000),
	carbs: z.number().min(0).max(1_000_000),
	fiber: z.number().min(0).max(1_000_000),
	sugar: z.number().min(0).max(1_000_000),
	protein: z.number().min(0).max(1_000_000)
});

export const recipeIngredientSchema = z.object({
	name: z.string().trim().min(1).max(200),
	quantity: z.number().min(0).max(1_000_000),
	unit: z.string().max(40)
});

export const recipeSchema = z.object({
	id: z.string().min(1).max(100),
	title: z.string().trim().min(1).max(200),
	description: z.string().max(10_000),
	image: z.union([publicUrlSchema, z.string().regex(COVER_PATH)]),
	time: z.number().min(0).max(100_000),
	servings: z.number().min(1).max(10_000),
	difficulty: z.string().max(80),
	cuisine: z.string().max(100),
	tags: z.array(z.string().max(100)).max(100),
	ingredients: z.array(recipeIngredientSchema).max(250),
	steps: z.array(z.string().max(10_000)).max(200),
	nutrition: nutritionSchema,
	source: publicUrlSchema.optional(),
	provenance: z.enum(['web-import', 'ai-generated', 'manual']).optional(),
	importNotes: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
	nutritionStale: z.boolean().optional(),
	rating: z.number().min(0).max(5).optional(),
	saved: z.boolean().optional(),
	sampleSaved: z.boolean().optional(),
	hidden: z.boolean().optional()
});

export const preferencesSchema = z.object({
	diet: z.string().max(200),
	allergies: z.string().max(2_000),
	maxTime: z.number().min(0).max(100_000),
	complexity: z.string().max(100),
	cuisines: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
	onboardingStatus: z.enum(['completed', 'skipped']).optional(),
	theme: z.string().max(100),
	dark: z.boolean(),
	provider: z.string().max(100),
	model: z.string().max(200),
	reasoning: z
		.object({
			effort: z
				.string()
				.regex(/^[a-z_]{1,24}$/)
				.optional(),
			enabled: z.boolean().optional(),
			budgetTokens: z.number().int().min(0).max(32_768).optional()
		})
		.optional(),
	chatgptAccountId: z.string().max(100).optional(),
	usePersonalAI: z.boolean().optional(),
	ratings: z.record(z.string().min(1).max(100), z.number().min(0).max(5)).optional()
});

export const appStateSchema = z.object({
	pantry: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				name: z.string().trim().min(1).max(200),
				quantity: z.number().min(0).max(1_000_000),
				unit: z.string().max(40),
				category: z.string().max(100),
				expires: z.string().max(50).optional(),
				sample: z.boolean().optional()
			})
		)
		.max(1_000),
	recipes: z.array(recipeSchema).max(MAX_RECIPES),
	meals: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				date: z.string().max(50),
				slot: z.string().max(100),
				recipeId: z.string().max(100),
				servings: z.number().finite().min(1).max(10_000),
				completedAt: z.string().max(50).optional(),
				leftoverServings: z.number().finite().min(0).max(10_000).optional(),
				pantryDeductions: z
					.array(
						z.object({
							pantryId: z.string().min(1).max(100),
							name: z.string().trim().min(1).max(200),
							quantity: z.number().finite().min(0).max(1_000_000),
							unit: z.string().max(40)
						})
					)
					.max(250)
					.optional(),
				sample: z.boolean().optional()
			})
		)
		.max(1_000),
	shopping: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				name: z.string().trim().min(1).max(200),
				quantity: z.number().min(0).max(1_000_000),
				unit: z.string().max(40),
				checked: z.boolean(),
				sourceKey: z.string().max(200).optional()
			})
		)
		.max(1_000),
	preferences: preferencesSchema
});

export function validateKitchenState(value: unknown): AppState | null {
	const parsed = appStateSchema.safeParse(value);
	return parsed.success ? (parsed.data as AppState) : null;
}

export function isKitchenState(value: unknown): value is AppState {
	return appStateSchema.safeParse(value).success;
}

export function isKitchenStateShape(value: unknown): value is AppState {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const state = value as Partial<AppState>;
	return (
		Array.isArray(state.pantry) &&
		Array.isArray(state.recipes) &&
		Array.isArray(state.meals) &&
		Array.isArray(state.shopping) &&
		!!state.preferences &&
		typeof state.preferences === 'object' &&
		!Array.isArray(state.preferences)
	);
}
