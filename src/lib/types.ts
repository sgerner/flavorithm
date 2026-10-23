import type { ReasoningSettings } from './ai-connections.ts';

export type Ingredient = {
	id: string;
	name: string;
	quantity: number;
	unit: string;
	category: string;
	expires?: string;
};
export type RecipeIngredient = { name: string; quantity: number; unit: string };
export type Recipe = {
	id: string;
	title: string;
	description: string;
	image: string;
	time: number;
	servings: number;
	difficulty: string;
	cuisine: string;
	tags: string[];
	ingredients: RecipeIngredient[];
	steps: string[];
	nutrition: {
		calories: number;
		fat: number;
		saturatedFat: number;
		sodium: number;
		carbs: number;
		fiber: number;
		sugar: number;
		protein: number;
	};
	source?: string;
	provenance?: 'web-import' | 'ai-generated';
	importNotes?: string[];
	nutritionStale?: boolean;
	rating?: number;
	saved?: boolean;
	hidden?: boolean;
};
export type Meal = {
	id: string;
	date: string;
	slot: string;
	recipeId: string;
	servings: number;
	completedAt?: string;
	leftoverServings?: number;
};
export type ShoppingItem = {
	id: string;
	name: string;
	quantity: number;
	unit: string;
	checked: boolean;
	sourceKey?: string;
};
export type Preferences = {
	diet: string;
	allergies: string;
	maxTime: number;
	complexity: string;
	cuisines?: string[];
	onboardingStatus?: 'completed' | 'skipped';
	theme: string;
	dark: boolean;
	provider: string;
	model: string;
	reasoning?: ReasoningSettings;
	ratings?: Record<string, number>;
	chatgptAccountId?: string;
};
export type AppState = {
	pantry: Ingredient[];
	recipes: Recipe[];
	meals: Meal[];
	shopping: ShoppingItem[];
	preferences: Preferences;
};
export type User = {
	id: string;
	name: string;
	email: string;
	householdId: string;
	emailVerified?: boolean;
};
