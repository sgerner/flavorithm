import test from 'node:test';
import assert from 'node:assert/strict';
import { COVER_PATH } from '../src/lib/cover-upload.ts';
import { createInitialState } from '../src/lib/data.ts';
import { focusFirstInvalid } from '../src/lib/focus.ts';
import {
	describeBy,
	fieldAria,
	fieldIds,
	validateEmail,
	validateInviteCode,
	validateLeftoverServings,
	validateMealDate,
	validatePantryInput,
	validatePassword,
	validatePlannedServings,
	validateRecipeDraftFields,
	validateRecipeLink,
	validateRegistrationName
} from '../src/lib/form-validation.ts';

test('fieldIds and fieldAria generate deterministic IDs and preserve helper IDs when invalid', () => {
	assert.deepEqual(fieldIds('plan-servings'), {
		id: 'plan-servings',
		labelId: 'plan-servings-label',
		helpId: 'plan-servings-help',
		errorId: 'plan-servings-error'
	});

	assert.equal(describeBy('a', undefined, false, 'b a', 'c'), 'a b c');
	assert.equal(describeBy(undefined, '', false), undefined);

	const validWithHelp = fieldAria('plan-servings', { hasHelp: true });
	assert.deepEqual(validWithHelp.props, {
		id: 'plan-servings',
		'aria-describedby': 'plan-servings-help',
		'aria-invalid': 'false'
	});

	const invalidWithHelp = fieldAria('plan-servings', {
		hasHelp: true,
		helpIds: ['extra-help'],
		error: 'Enter a whole number from 1 to 24 servings.'
	});
	assert.deepEqual(invalidWithHelp.props, {
		id: 'plan-servings',
		'aria-describedby': 'plan-servings-help extra-help plan-servings-error',
		'aria-invalid': 'true'
	});

	const serverErrorLinked = fieldAria('auth-email', {
		errorId: 'auth-form-error',
		invalid: true
	});
	assert.deepEqual(serverErrorLinked.props, {
		id: 'auth-email',
		'aria-describedby': 'auth-form-error',
		'aria-invalid': 'true'
	});
});

test('meal, leftover, pantry, invite, and auth validators enforce exact bounds', () => {
	assert.equal(validateMealDate('2026-11-22'), '');
	assert.match(validateMealDate(''), /Choose a date/);
	assert.match(validateMealDate('not-a-date'), /Choose a date/);

	assert.equal(validatePlannedServings(1), '');
	assert.equal(validatePlannedServings(24), '');
	assert.equal(validatePlannedServings(10_000), '');
	assert.match(validatePlannedServings(0), /1 to 10,000/);
	assert.match(validatePlannedServings(10_001), /1 to 10,000/);
	assert.match(validatePlannedServings(2.5), /1 to 10,000/);
	assert.match(validatePlannedServings(null), /1 to 10,000/);

	assert.equal(validateLeftoverServings(0, 4), '');
	assert.equal(validateLeftoverServings(4, 4), '');
	assert.match(validateLeftoverServings(-1, 4), /0 to 4/);
	assert.match(validateLeftoverServings(5, 4), /0 to 4/);
	assert.match(validateLeftoverServings(1.5, 4), /0 to 4/);

	assert.equal(validateRecipeLink(''), '');
	assert.equal(validateRecipeLink('https://example.com/recipe'), '');
	assert.equal(validateRecipeLink('http://example.com/recipe'), '');
	assert.match(validateRecipeLink('ftp://example.com/recipe'), /http:\/\/ or https:\/\//);
	assert.match(validateRecipeLink('not-a-link'), /http:\/\/ or https:\/\//);

	assert.equal(validateRegistrationName('Ada Lovelace'), '');
	assert.match(validateRegistrationName('A'), /2 to 80/);

	assert.equal(validateEmail('cook@example.com'), '');
	assert.match(validateEmail('invalid-email'), /valid email/);

	assert.equal(validatePassword('tencharpwd', 'register'), '');
	assert.equal(validatePassword('tencharpwd', 'reset'), '');
	assert.match(validatePassword('short1234', 'register'), /10 and 128/);
	assert.match(validatePassword('short1234', 'reset'), /10 and 128/);
	assert.equal(validatePassword('short', 'login'), '');
	assert.match(validatePassword('', 'login'), /Enter your password/);
	assert.match(validatePassword('', 'delete'), /confirm account deletion/);

	assert.equal(validatePantryInput('2 eggs, spinach'), '');
	assert.equal(validatePantryInput('1 1/2 cups milk [Dairy, Eggs]'), '');
	assert.match(validatePantryInput(' , \n ; '), /at least one ingredient/);
	assert.match(validatePantryInput('0 g flour'), /quantity above zero/);

	assert.equal(validateInviteCode('INV-123'), '');
	assert.match(validateInviteCode('   '), /invitation code/);
});

test('validateRecipeDraftFields reports per-field errors including nutrition and image URLs', () => {
	const base = structuredClone(createInitialState().recipes[0]);
	const clean = validateRecipeDraftFields(base, {
		tagsText: base.tags.join(', '),
		checkImage: true,
		coverPathPattern: COVER_PATH
	});
	assert.equal(clean.hasErrors, false);
	assert.equal(clean.summary, '');

	const broken = structuredClone(base);
	broken.title = '   ';
	broken.time = 0;
	broken.servings = 0;
	broken.image = 'http://insecure.example/photo.jpg';
	broken.ingredients[0] = { name: '', quantity: -2, unit: '' };
	broken.steps[0] = '   ';
	broken.nutrition.calories = -10;
	broken.nutrition.sodium = Number.NaN;

	const result = validateRecipeDraftFields(broken, {
		tagsText: Array.from({ length: 31 }, (_, i) => `tag-${i}`).join(', '),
		checkImage: true,
		coverPathPattern: COVER_PATH
	});
	assert.equal(result.hasErrors, true);
	assert.equal(result.hasNutritionErrors, true);
	assert.match(result.title, /recipe title/);
	assert.match(result.time, /cooking time/);
	assert.match(result.servings, /servings/);
	assert.match(result.image, /HTTPS image URL/);
	assert.match(result.tags, /30 tags/);
	assert.match(result.ingredients[0].name ?? '', /ingredient 1/i);
	assert.match(result.ingredients[0].quantity ?? '', /ingredient 1/i);
	assert.match(result.ingredients[0].unit ?? '', /ingredient 1/i);
	assert.match(result.steps[0], /step 1/i);
	assert.match(result.nutrition.calories ?? '', /calories/i);
	assert.match(result.nutrition.sodium ?? '', /sodium/i);
	assert.equal(result.nutrition.protein, undefined);
	assert.match(result.summary, /^Fix \d+ fields before saving:/);
});

test('focusFirstInvalid expands closed ancestor details disclosures and focuses the control', () => {
	let focused = false;
	const outerDetails: Record<string, unknown> = { open: false, parentElement: null };
	const innerDetails: Record<string, unknown> = {
		open: false,
		parentElement: {
			closest: (selector: string) => (selector === 'details' ? outerDetails : null)
		}
	};
	const invalidInput = {
		closest: (selector: string) => (selector === 'details' ? innerDetails : null),
		scrollIntoView: () => {},
		focus: () => {
			focused = true;
		}
	} as unknown as HTMLElement;

	const container = {
		querySelector: () => invalidInput
	} as unknown as ParentNode;

	const target = focusFirstInvalid(container);
	assert.equal(target, invalidInput);
	assert.equal(innerDetails.open, true);
	assert.equal(outerDetails.open, true);
	assert.equal(focused, true);
});
