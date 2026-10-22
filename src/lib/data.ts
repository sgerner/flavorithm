import type { AppState, Ingredient, Meal, Preferences, Recipe } from './types';

const photo = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1400&q=85`;

/** A small, hand-curated starter collection with a mix of weeknight-friendly meals. */
export const seedRecipes: Recipe[] = [
	{
		id: 'lemon-herb-chicken',
		title: 'Lemon-herb chicken & crispy potatoes',
		description:
			'Golden chicken, buttery little potatoes, and tender green beans finished with a bright pan sauce.',
		image: photo('photo-1532550907401-a500c9a57435'),
		time: 40,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Mediterranean',
		tags: ['high-protein', 'weeknight', 'gluten-free'],
		ingredients: [
			{ name: 'boneless chicken thighs', quantity: 12, unit: 'oz' },
			{ name: 'baby potatoes', quantity: 12, unit: 'oz' },
			{ name: 'green beans', quantity: 8, unit: 'oz' },
			{ name: 'lemon', quantity: 1, unit: 'whole' },
			{ name: 'garlic', quantity: 3, unit: 'cloves' },
			{ name: 'olive oil', quantity: 1, unit: 'tbsp' },
			{ name: 'butter', quantity: 1, unit: 'tbsp' },
			{ name: 'fresh thyme', quantity: 1, unit: 'tsp' },
			{ name: 'chicken broth', quantity: 0.25, unit: 'cup' },
			{ name: 'kosher salt', quantity: 0.5, unit: 'tsp' },
			{ name: 'black pepper', quantity: 0.25, unit: 'tsp' }
		],
		steps: [
			'Heat the oven to 425°F (220°C). Halve the potatoes, toss with half the olive oil, a pinch of salt, and pepper, then roast cut-side down for 20 minutes.',
			'Pat the chicken dry. Season with salt, pepper, and thyme. Warm the remaining oil in an oven-safe skillet over medium-high heat and brown the chicken for 3 minutes per side.',
			'Add the green beans and crushed garlic to the skillet. Transfer the skillet to the oven and roast until the chicken reaches 165°F (74°C), about 10–12 minutes.',
			'Return the skillet to the stovetop. Stir in the broth, butter, lemon zest, and a squeeze of lemon; scrape up the browned bits and simmer for 1 minute.',
			'Serve the chicken and beans with the crisp potatoes and spoon the lemon pan sauce over everything.'
		],
		nutrition: {
			calories: 565,
			fat: 27,
			saturatedFat: 8,
			sodium: 690,
			carbs: 37,
			fiber: 6,
			sugar: 5,
			protein: 42
		},
		saved: true
	},
	{
		id: 'sesame-salmon-bowls',
		title: 'Sesame salmon rice bowls',
		description:
			'Flaky salmon, cool cucumber, and warm rice with a quick ginger-soy glaze and a little crunch.',
		image: photo('photo-1467003909585-2f8a72700288'),
		time: 30,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Japanese-inspired',
		tags: ['high-protein', 'quick', 'dairy-free'],
		ingredients: [
			{ name: 'salmon fillets', quantity: 10, unit: 'oz' },
			{ name: 'jasmine rice', quantity: 0.75, unit: 'cup' },
			{ name: 'cucumber', quantity: 1, unit: 'whole' },
			{ name: 'carrot', quantity: 1, unit: 'whole' },
			{ name: 'avocado', quantity: 1, unit: 'whole' },
			{ name: 'low-sodium soy sauce', quantity: 1.5, unit: 'tbsp' },
			{ name: 'honey', quantity: 1, unit: 'tsp' },
			{ name: 'fresh ginger', quantity: 1, unit: 'tsp' },
			{ name: 'rice vinegar', quantity: 1, unit: 'tbsp' },
			{ name: 'sesame seeds', quantity: 1, unit: 'tsp' },
			{ name: 'scallions', quantity: 2, unit: 'whole' }
		],
		steps: [
			'Rinse the rice until the water runs mostly clear. Cook according to the package directions while you prepare the rest of the bowl.',
			'Whisk the soy sauce, honey, grated ginger, and 1 teaspoon water. Pat the salmon dry and brush it with half of the glaze.',
			'Broil the salmon on a foil-lined tray for 7–9 minutes, until it flakes easily and is just opaque in the center.',
			'Toss thinly sliced cucumber and carrot with the rice vinegar and a pinch of salt. Slice the avocado and scallions.',
			'Spoon rice into bowls. Add the salmon, quick-pickled vegetables, and avocado; finish with the remaining glaze, sesame seeds, and scallions.'
		],
		nutrition: {
			calories: 590,
			fat: 23,
			saturatedFat: 4,
			sodium: 620,
			carbs: 57,
			fiber: 8,
			sugar: 8,
			protein: 35
		},
		saved: true
	},
	{
		id: 'tomato-butter-beans',
		title: 'Tomato butter beans with garlicky toast',
		description:
			'Creamy beans simmered in a jammy tomato and rosemary sauce, with crisp sourdough for scooping.',
		image: photo('photo-1547592180-85f173990554'),
		time: 25,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Italian-inspired',
		tags: ['vegetarian', 'quick', 'comfort-food'],
		ingredients: [
			{ name: 'cannellini beans', quantity: 1, unit: 'can (15 oz)' },
			{ name: 'cherry tomatoes', quantity: 10, unit: 'oz' },
			{ name: 'shallot', quantity: 1, unit: 'whole' },
			{ name: 'garlic', quantity: 2, unit: 'cloves' },
			{ name: 'vegetable broth', quantity: 0.5, unit: 'cup' },
			{ name: 'tomato paste', quantity: 1, unit: 'tbsp' },
			{ name: 'fresh rosemary', quantity: 1, unit: 'tsp' },
			{ name: 'baby spinach', quantity: 2, unit: 'cups' },
			{ name: 'sourdough bread', quantity: 2, unit: 'slices' },
			{ name: 'parmesan', quantity: 2, unit: 'tbsp' },
			{ name: 'olive oil', quantity: 1, unit: 'tbsp' }
		],
		steps: [
			'Warm the olive oil in a deep skillet over medium heat. Add the sliced shallot and cook until soft, about 3 minutes.',
			'Stir in the garlic, tomato paste, and rosemary. Cook for 30 seconds, then add the tomatoes and a pinch of salt. Let them blister for 4 minutes.',
			'Add the drained beans and broth. Simmer gently for 8 minutes, lightly crushing a few beans against the side of the pan to thicken the sauce.',
			'Fold in the spinach until just wilted. Taste and adjust the seasoning, then shower with parmesan.',
			'Toast the sourdough and rub each slice with a cut garlic clove. Serve alongside the warm beans.'
		],
		nutrition: {
			calories: 480,
			fat: 13,
			saturatedFat: 3,
			sodium: 810,
			carbs: 68,
			fiber: 15,
			sugar: 10,
			protein: 23
		},
		saved: true
	},
	{
		id: 'lemon-chickpea-orzo',
		title: 'Lemony chickpea orzo with spinach',
		description:
			'A one-pan, risotto-like orzo with chickpeas, wilted greens, lemon, and a generous finish of herbs.',
		image: photo('photo-1473093295043-cdd812d0e601'),
		time: 28,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Greek-inspired',
		tags: ['vegetarian', 'quick', 'one-pan'],
		ingredients: [
			{ name: 'orzo', quantity: 0.75, unit: 'cup' },
			{ name: 'chickpeas', quantity: 1, unit: 'can (15 oz)' },
			{ name: 'baby spinach', quantity: 3, unit: 'cups' },
			{ name: 'vegetable broth', quantity: 2, unit: 'cups' },
			{ name: 'shallot', quantity: 1, unit: 'whole' },
			{ name: 'lemon', quantity: 1, unit: 'whole' },
			{ name: 'feta', quantity: 2, unit: 'oz' },
			{ name: 'dill', quantity: 2, unit: 'tbsp' },
			{ name: 'olive oil', quantity: 1, unit: 'tbsp' },
			{ name: 'black pepper', quantity: 0.25, unit: 'tsp' }
		],
		steps: [
			'Heat the olive oil in a deep skillet. Add the minced shallot and cook until fragrant and translucent, about 2 minutes.',
			'Stir in the orzo and toast for 1 minute. Pour in the broth, bring to a gentle boil, then lower the heat and simmer uncovered for 8–10 minutes, stirring often.',
			'When the orzo is nearly tender, fold in the drained chickpeas and spinach. Cook for 2 minutes until the greens wilt and the broth turns silky.',
			'Remove from the heat. Stir through the lemon zest and juice, chopped dill, and black pepper.',
			'Spoon into bowls and crumble the feta over the top. Add another squeeze of lemon if you like it extra bright.'
		],
		nutrition: {
			calories: 525,
			fat: 16,
			saturatedFat: 5,
			sodium: 780,
			carbs: 75,
			fiber: 13,
			sugar: 8,
			protein: 24
		},
		saved: false
	},
	{
		id: 'maple-chili-tofu',
		title: 'Maple-chili tofu & crunchy broccoli',
		description:
			'Crisp-edged tofu and charred broccoli glazed with a sticky, gently spicy maple-soy sauce.',
		image: photo('photo-1512621776951-a57141f2eefd'),
		time: 35,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Asian-inspired',
		tags: ['vegan', 'high-protein', 'dairy-free'],
		ingredients: [
			{ name: 'extra-firm tofu', quantity: 12, unit: 'oz' },
			{ name: 'broccoli', quantity: 1, unit: 'large head' },
			{ name: 'brown rice', quantity: 0.75, unit: 'cup' },
			{ name: 'cornstarch', quantity: 1, unit: 'tbsp' },
			{ name: 'low-sodium soy sauce', quantity: 2, unit: 'tbsp' },
			{ name: 'maple syrup', quantity: 1, unit: 'tbsp' },
			{ name: 'rice vinegar', quantity: 1, unit: 'tbsp' },
			{ name: 'chili crisp', quantity: 1, unit: 'tsp' },
			{ name: 'sesame oil', quantity: 1, unit: 'tsp' },
			{ name: 'scallions', quantity: 2, unit: 'whole' }
		],
		steps: [
			'Heat the oven to 425°F (220°C). Start the rice according to its package directions.',
			'Press excess water from the tofu and tear it into bite-size pieces. Toss with cornstarch and a pinch of salt, then spread on a lined baking tray.',
			'Cut the broccoli into small florets. Toss with a little oil and salt, then add to the tray. Roast everything for 22–25 minutes, turning once, until crisp at the edges.',
			'Whisk together the soy sauce, maple syrup, rice vinegar, chili crisp, sesame oil, and 1 tablespoon water. Warm in a small pan until glossy, about 1 minute.',
			'Toss the hot tofu with the glaze. Serve over rice with the roasted broccoli and sliced scallions.'
		],
		nutrition: {
			calories: 545,
			fat: 18,
			saturatedFat: 3,
			sodium: 720,
			carbs: 70,
			fiber: 9,
			sugar: 12,
			protein: 29
		},
		saved: false
	},
	{
		id: 'roasted-veg-farro',
		title: 'Roasted vegetable farro with whipped feta',
		description:
			'Chewy farro tossed with caramelized squash and red onion, brightened with lemony whipped feta.',
		image: photo('photo-1490645935967-10de6ba17061'),
		time: 45,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Mediterranean',
		tags: ['vegetarian', 'make-ahead', 'whole-grain'],
		ingredients: [
			{ name: 'farro', quantity: 0.75, unit: 'cup' },
			{ name: 'butternut squash', quantity: 10, unit: 'oz' },
			{ name: 'red onion', quantity: 1, unit: 'small' },
			{ name: 'baby kale', quantity: 2, unit: 'cups' },
			{ name: 'feta', quantity: 3, unit: 'oz' },
			{ name: 'plain Greek yogurt', quantity: 2, unit: 'tbsp' },
			{ name: 'lemon', quantity: 1, unit: 'whole' },
			{ name: 'pumpkin seeds', quantity: 2, unit: 'tbsp' },
			{ name: 'olive oil', quantity: 1.5, unit: 'tbsp' },
			{ name: 'fresh parsley', quantity: 2, unit: 'tbsp' }
		],
		steps: [
			'Heat the oven to 425°F (220°C). Toss peeled squash cubes and thick slices of red onion with 1 tablespoon olive oil, salt, and pepper.',
			'Roast the vegetables on a sheet pan for 25–30 minutes, turning once, until browned and tender.',
			'Meanwhile, simmer the farro in salted water according to the package directions, usually 25–30 minutes. Drain well.',
			'Blend or mash the feta with the Greek yogurt, lemon zest, and 1 teaspoon lemon juice until creamy. Loosen with a teaspoon of water if needed.',
			'Toss warm farro with the remaining olive oil, a squeeze of lemon, and chopped parsley. Fold in the kale so it softens, then top with roasted vegetables, whipped feta, and pumpkin seeds.'
		],
		nutrition: {
			calories: 610,
			fat: 23,
			saturatedFat: 8,
			sodium: 760,
			carbs: 82,
			fiber: 12,
			sugar: 12,
			protein: 24
		},
		saved: false
	},
	{
		id: 'chicken-shawarma-wraps',
		title: 'Chicken shawarma wraps with herby yogurt',
		description:
			'Warm spiced chicken tucked into soft flatbreads with crunchy cucumber, tomato, and cool herbed yogurt.',
		image: photo('photo-1529006557810-274b9b2fc783'),
		time: 35,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Middle Eastern-inspired',
		tags: ['high-protein', 'weeknight', 'family-friendly'],
		ingredients: [
			{ name: 'chicken breast', quantity: 12, unit: 'oz' },
			{ name: 'plain Greek yogurt', quantity: 0.5, unit: 'cup' },
			{ name: 'ground cumin', quantity: 1, unit: 'tsp' },
			{ name: 'smoked paprika', quantity: 1, unit: 'tsp' },
			{ name: 'ground coriander', quantity: 0.5, unit: 'tsp' },
			{ name: 'garlic', quantity: 2, unit: 'cloves' },
			{ name: 'lemon', quantity: 1, unit: 'whole' },
			{ name: 'Persian cucumbers', quantity: 2, unit: 'whole' },
			{ name: 'tomatoes', quantity: 1, unit: 'medium' },
			{ name: 'flatbread', quantity: 2, unit: 'pieces' },
			{ name: 'fresh mint', quantity: 1, unit: 'tbsp' }
		],
		steps: [
			'Whisk together the cumin, paprika, coriander, half the minced garlic, 1 tablespoon olive oil, lemon zest, and a pinch of salt. Coat the chicken and leave it while the pan heats.',
			'Stir the yogurt with the remaining garlic, chopped mint, a squeeze of lemon, and salt. Thin with a teaspoon of water if you want it drizzleable.',
			'Cook the chicken in a hot skillet for 5–7 minutes per side, depending on thickness, until browned and 165°F (74°C) inside. Rest for 5 minutes, then slice.',
			'Warm the flatbreads in a dry pan. Slice the cucumbers and tomato and season them lightly.',
			'Spread each flatbread with herby yogurt, add the sliced chicken and vegetables, then roll up and serve with extra sauce.'
		],
		nutrition: {
			calories: 545,
			fat: 14,
			saturatedFat: 4,
			sodium: 840,
			carbs: 54,
			fiber: 5,
			sugar: 8,
			protein: 49
		},
		saved: false
	},
	{
		id: 'coconut-red-lentil-dal',
		title: 'Coconut red lentil dal',
		description:
			'A gently spiced, velvety lentil pot with coconut milk, wilted spinach, and lime to wake it up.',
		image: photo('photo-1603894584373-5ac82b2ae398'),
		time: 38,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'South Asian-inspired',
		tags: ['vegan', 'comfort-food', 'meal-prep'],
		ingredients: [
			{ name: 'red lentils', quantity: 0.75, unit: 'cup' },
			{ name: 'light coconut milk', quantity: 1, unit: 'cup' },
			{ name: 'vegetable broth', quantity: 1, unit: 'cup' },
			{ name: 'yellow onion', quantity: 1, unit: 'small' },
			{ name: 'garlic', quantity: 3, unit: 'cloves' },
			{ name: 'fresh ginger', quantity: 1, unit: 'tbsp' },
			{ name: 'curry powder', quantity: 2, unit: 'tsp' },
			{ name: 'baby spinach', quantity: 2, unit: 'cups' },
			{ name: 'lime', quantity: 1, unit: 'whole' },
			{ name: 'basmati rice', quantity: 0.75, unit: 'cup' },
			{ name: 'cilantro', quantity: 2, unit: 'tbsp' }
		],
		steps: [
			'Rinse the lentils. In a saucepan, warm a teaspoon of oil and cook the diced onion until soft, about 4 minutes.',
			'Add the garlic, grated ginger, and curry powder. Stir for 30 seconds until fragrant.',
			'Stir in the lentils, coconut milk, broth, and a pinch of salt. Bring to a boil, then simmer gently for 20–25 minutes, stirring now and then, until creamy.',
			'Cook the rice while the lentils simmer. Fold the spinach into the dal for the final 2 minutes.',
			'Finish with lime juice and chopped cilantro. Serve over rice with more lime at the table.'
		],
		nutrition: {
			calories: 575,
			fat: 16,
			saturatedFat: 10,
			sodium: 590,
			carbs: 87,
			fiber: 15,
			sugar: 8,
			protein: 24
		},
		saved: false
	}
];

export const seedPantry: Ingredient[] = [
	{
		id: 'pantry-olive-oil',
		name: 'olive oil',
		quantity: 0.5,
		unit: 'cup',
		category: 'Oils & condiments'
	},
	{ id: 'pantry-garlic', name: 'garlic', quantity: 1, unit: 'head', category: 'Produce' },
	{ id: 'pantry-spinach', name: 'baby spinach', quantity: 2, unit: 'cups', category: 'Produce' },
	{ id: 'pantry-rice', name: 'jasmine rice', quantity: 2, unit: 'cups', category: 'Grains' },
	{
		id: 'pantry-soy-sauce',
		name: 'low-sodium soy sauce',
		quantity: 0.25,
		unit: 'cup',
		category: 'Oils & condiments'
	},
	{
		id: 'pantry-chickpeas',
		name: 'chickpeas',
		quantity: 1,
		unit: 'can (15 oz)',
		category: 'Canned goods'
	},
	{ id: 'pantry-eggs', name: 'eggs', quantity: 4, unit: 'whole', category: 'Dairy & eggs' }
];

export const defaultPreferences: Preferences = {
	diet: 'none',
	allergies: '',
	maxTime: 45,
	complexity: 'Easy',
	theme: 'nosh',
	dark: false,
	provider: 'openai',
	model: 'gpt-4o-mini'
};

/** A clean account starts with the curated recipe collection and an empty kitchen. */
export function createNewUserState(): AppState {
	return {
		pantry: [],
		recipes: structuredClone(seedRecipes).map((recipe) => ({ ...recipe, saved: false })),
		meals: [],
		shopping: [],
		preferences: structuredClone(defaultPreferences)
	};
}

function dateAtWeekday(day: number): string {
	const today = new Date();
	const mondayOffset = (today.getDay() + 6) % 7;
	const date = new Date(
		today.getFullYear(),
		today.getMonth(),
		today.getDate() - mondayOffset + day
	);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createInitialState(): AppState {
	const recipes = structuredClone(seedRecipes);
	const meals: Meal[] = [
		{
			id: 'meal-week-tue',
			date: dateAtWeekday(1),
			slot: 'Dinner',
			recipeId: 'lemon-herb-chicken',
			servings: 2
		},
		{
			id: 'meal-week-thu',
			date: dateAtWeekday(3),
			slot: 'Dinner',
			recipeId: 'lemon-chickpea-orzo',
			servings: 2
		},
		{
			id: 'meal-week-sat',
			date: dateAtWeekday(5),
			slot: 'Lunch',
			recipeId: 'sesame-salmon-bowls',
			servings: 2
		}
	];
	return {
		pantry: structuredClone(seedPantry),
		recipes,
		meals,
		shopping: [],
		preferences: structuredClone(defaultPreferences)
	};
}
