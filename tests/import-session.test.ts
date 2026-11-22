import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import {
	appendImportTranscript,
	applyImportedRecipeSave,
	canAppendImportTranscript,
	clearImportSourceInPlace,
	cloneImportSession,
	emptyImportSession,
	hasUnsavedImportContent,
	isReviewingImportDraft,
	MAX_IMPORT_TEXT_LENGTH,
	replaceImportSessionWithUrl,
	type ImportSession
} from '#lib/import-session.ts';
import { MAX_RECIPES } from '#lib/recipe-collection.ts';
import { createDraftBaseline } from '#lib/recipe-draft.ts';
import type { Recipe } from '#lib/types.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const { validateAppState } = await import('#lib/server/db.ts');

const makeRecipe = (id: string, overrides: Partial<Recipe> = {}): Recipe => ({
	...structuredClone(seedRecipes[0]),
	id,
	...overrides
});

test('online search import over an empty session loads the link without offering undo', () => {
	const initial = emptyImportSession();
	assert.equal(hasUnsavedImportContent(initial), false);

	const { session, previous } = replaceImportSessionWithUrl(
		initial,
		'https://example.com/recipes/lemon-pasta'
	);
	assert.equal(session.url, 'https://example.com/recipes/lemon-pasta');
	assert.equal(session.text, '');
	assert.equal(session.photo, '');
	assert.equal(session.draft, null);
	assert.equal(session.reviewingDraft, false);
	assert.equal(previous, null);

	const repeated = replaceImportSessionWithUrl(session, 'https://example.com/recipes/lemon-pasta');
	assert.equal(repeated.previous, null);
});

test('online search import over active draft/photo offers undo restoring url, text, photo, draft, notes, and view', () => {
	const draft = makeRecipe('draft-1', { title: 'Roasted Cauliflower Tacos', servings: 4 });
	const baseline = createDraftBaseline(draft);
	draft.servings = 6;
	const activeReview: ImportSession = {
		url: 'https://example.com/recipes/cauliflower-tacos',
		text: 'cauliflower, lime, warm tortillas',
		photo:
			'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
		photoName: 'tacos-card.png',
		draft,
		baseline,
		assumptions: ['Assumed 2 tsp cumin', 'Estimated 4 servings'],
		reviewingDraft: true
	};

	const replaced = replaceImportSessionWithUrl(
		activeReview,
		'https://example.com/recipes/tomato-soup'
	);
	assert.equal(replaced.session.url, 'https://example.com/recipes/tomato-soup');
	assert.equal(replaced.session.text, '');
	assert.equal(replaced.session.photo, '');
	assert.equal(replaced.session.draft, null);
	assert.equal(isReviewingImportDraft(replaced.session), false);
	assert.ok(replaced.previous);

	// Mutating the original draft after replacement cannot corrupt the undo snapshot.
	draft.title = 'Mutated title';
	const restoredReview = cloneImportSession(replaced.previous);
	assert.equal(restoredReview.url, 'https://example.com/recipes/cauliflower-tacos');
	assert.equal(restoredReview.text, 'cauliflower, lime, warm tortillas');
	assert.equal(restoredReview.photoName, 'tacos-card.png');
	assert.equal(restoredReview.photo.startsWith('data:image/png;base64,'), true);
	assert.equal(restoredReview.draft?.title, 'Roasted Cauliflower Tacos');
	assert.equal(restoredReview.draft?.servings, 6);
	assert.equal(restoredReview.baseline?.servings, 4);
	assert.deepEqual(restoredReview.assumptions, ['Assumed 2 tsp cumin', 'Estimated 4 servings']);
	assert.equal(isReviewingImportDraft(restoredReview), true);

	// Also preserves source-screen view when user had navigated Back before importing from search.
	const activeSourceView: ImportSession = { ...restoredReview, reviewingDraft: false };
	const replacedFromSource = replaceImportSessionWithUrl(
		activeSourceView,
		'https://example.com/recipes/chili'
	);
	assert.ok(replacedFromSource.previous);
	const restoredSource = cloneImportSession(replacedFromSource.previous);
	assert.equal(restoredSource.draft?.title, 'Roasted Cauliflower Tacos');
	assert.equal(isReviewingImportDraft(restoredSource), false);
});

test('import workspace remembers source screen vs review screen across closes and reopens', () => {
	const session = emptyImportSession();
	assert.equal(isReviewingImportDraft(session), false);

	// Generating a draft switches to review.
	session.draft = makeRecipe('draft-2', { title: 'Herb Risotto' });
	session.assumptions = ['Assumed arborio rice'];
	session.reviewingDraft = true;
	assert.equal(isReviewingImportDraft(cloneImportSession(session)), true);

	// Navigating Back switches to source while keeping draft & assumptions across dialog reopen.
	session.reviewingDraft = false;
	const reopenedOnSource = cloneImportSession(session);
	assert.equal(isReviewingImportDraft(reopenedOnSource), false);
	assert.equal(reopenedOnSource.draft?.title, 'Herb Risotto');
	assert.deepEqual(reopenedOnSource.assumptions, ['Assumed arborio rice']);

	// Returning to reviewed draft restores review across dialog reopen.
	reopenedOnSource.reviewingDraft = true;
	assert.equal(isReviewingImportDraft(cloneImportSession(reopenedOnSource)), true);
});

test('voice dictation appends on source view even with a draft and ignores late transcripts on review or close', () => {
	const voiceDraft = makeRecipe('draft-voice');
	const session: ImportSession = {
		url: '',
		text: '2 cups chickpeas',
		photo: '',
		photoName: '',
		draft: voiceDraft,
		baseline: createDraftBaseline(voiceDraft),
		assumptions: ['Assumed cooked chickpeas'],
		reviewingDraft: false
	};

	assert.equal(
		canAppendImportTranscript({
			modal: 'import',
			currentSession: session,
			startedSession: session,
			currentUserId: 'user-1',
			startedUserId: 'user-1'
		}),
		true
	);
	session.text = appendImportTranscript(session.text, 'add smoked paprika and lemon zest');
	assert.equal(session.text, '2 cups chickpeas\nadd smoked paprika and lemon zest');

	// Switching to review screen blocks late transcripts.
	session.reviewingDraft = true;
	assert.equal(
		canAppendImportTranscript({
			modal: 'import',
			currentSession: session,
			startedSession: session,
			currentUserId: 'user-1',
			startedUserId: 'user-1'
		}),
		false
	);

	// Closing dialog blocks late transcripts even when on source view.
	session.reviewingDraft = false;
	assert.equal(
		canAppendImportTranscript({
			modal: '',
			currentSession: session,
			startedSession: session,
			currentUserId: 'user-1',
			startedUserId: 'user-1'
		}),
		false
	);

	// Replacing session or changing account blocks late transcripts.
	assert.equal(
		canAppendImportTranscript({
			modal: 'import',
			currentSession: emptyImportSession(),
			startedSession: session,
			currentUserId: 'user-1',
			startedUserId: 'user-1'
		}),
		false
	);
	assert.equal(
		canAppendImportTranscript({
			modal: 'import',
			currentSession: session,
			startedSession: session,
			currentUserId: 'user-2',
			startedUserId: 'user-1'
		}),
		false
	);

	// Enforces 20,000-character ceiling.
	const oversized = appendImportTranscript('a'.repeat(19_995), '1234567890');
	assert.equal(oversized.length, MAX_IMPORT_TEXT_LENGTH);
	assert.equal(oversized, `${'a'.repeat(19_995)}\n1234`);
});

test('clearing source removes only text and photo while preserving draft, estimate notes, and session identity', () => {
	const keptDraft = makeRecipe('draft-keep', { title: 'Shakshuka', servings: 4 });
	const keptBaseline = createDraftBaseline(keptDraft);
	const session: ImportSession = {
		url: 'https://example.com/shakshuka',
		text: 'old pasted notes',
		photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
		photoName: 'notes.jpg',
		draft: keptDraft,
		baseline: keptBaseline,
		assumptions: ['Assumed 4 large eggs'],
		reviewingDraft: false
	};
	const originalReference = session;

	clearImportSourceInPlace(session);
	assert.equal(session, originalReference);
	assert.equal(session.url, '');
	assert.equal(session.text, '');
	assert.equal(session.photo, '');
	assert.equal(session.photoName, '');
	assert.equal(session.draft?.title, 'Shakshuka');
	assert.deepEqual(session.baseline, keptBaseline);
	assert.deepEqual(session.assumptions, ['Assumed 4 large eggs']);
	assert.equal(isReviewingImportDraft(session), false);

	// Discard draft resets everything.
	const discarded = emptyImportSession();
	assert.deepEqual(discarded, {
		url: '',
		text: '',
		photo: '',
		photoName: '',
		draft: null,
		baseline: null,
		assumptions: [],
		reviewingDraft: false
	});
});

test('saving an imported recipe offers undo restoring prior recipes, replaced entries, and review draft', () => {
	const kitchen = createNewUserState();
	const originalTarget = structuredClone(kitchen.recipes[2]);
	const replacementBaseline = createDraftBaseline(
		makeRecipe(originalTarget.id, { servings: 2, ingredients: originalTarget.ingredients })
	);
	const replacementDraft = makeRecipe(originalTarget.id, {
		title: 'Accidentally Replaced Soup',
		servings: 6,
		importNotes: ['Estimated 1 tbsp olive oil'],
		saved: true
	});
	const session: ImportSession = {
		url: 'https://example.com/soup',
		text: 'make it extra garlicky',
		photo: '',
		photoName: '',
		draft: replacementDraft,
		baseline: replacementBaseline,
		assumptions: ['Estimated 1 tbsp olive oil'],
		reviewingDraft: true
	};

	const applied = applyImportedRecipeSave(kitchen, session, replacementDraft);
	assert.equal(applied.saved.nutritionStale, true);
	assert.equal(applied.nextRecipes.length, kitchen.recipes.length);
	assert.equal(applied.nextRecipes[0].id, originalTarget.id);
	assert.equal(applied.nextRecipes[0].title, 'Accidentally Replaced Soup');
	assert.deepEqual(applied.nextSession, emptyImportSession());

	// Simulate server /api/state validation round-trip (which normalizes key ordering via Zod).
	const syncedKitchen = validateAppState({ ...kitchen, recipes: applied.nextRecipes });
	assert.ok(syncedKitchen);

	const rolledBack = applied.rollback(syncedKitchen);
	assert.equal(rolledBack.ok, true);
	if (rolledBack.ok) {
		assert.deepEqual(rolledBack.kitchen.recipes, kitchen.recipes);
		assert.equal(rolledBack.kitchen.recipes[2].id, originalTarget.id);
		assert.equal(rolledBack.kitchen.recipes[2].title, originalTarget.title);
		assert.equal(rolledBack.session.draft?.title, 'Accidentally Replaced Soup');
		assert.equal(rolledBack.session.baseline?.servings, 2);
		assert.equal(rolledBack.session.url, 'https://example.com/soup');
		assert.equal(rolledBack.session.text, 'make it extra garlicky');
		assert.deepEqual(rolledBack.session.assumptions, ['Estimated 1 tbsp olive oil']);
		assert.equal(isReviewingImportDraft(rolledBack.session), true);
	}
});

test('save undo keeps newer kitchen edits when the kitchen changes before undo', () => {
	const kitchen = createNewUserState();
	const imported = makeRecipe('new-import', { title: 'Crispy Tofu Bowl', saved: true });
	const session: ImportSession = {
		url: '',
		text: 'tofu, rice, cucumber',
		photo: '',
		photoName: '',
		draft: imported,
		baseline: createDraftBaseline(imported),
		assumptions: [],
		reviewingDraft: true
	};

	const applied = applyImportedRecipeSave(kitchen, session, imported);
	const editedKitchen = {
		...kitchen,
		recipes: applied.nextRecipes,
		pantry: [{ id: 'p-1', name: 'tofu', quantity: 1, unit: 'piece', category: 'Protein' }]
	};

	const rolledBack = applied.rollback(editedKitchen);
	assert.deepEqual(rolledBack, { ok: false });

	// Full collection still throws cleanly before mutating state.
	const fullKitchen = {
		...kitchen,
		recipes: Array.from({ length: MAX_RECIPES }, (_, i) => makeRecipe(`r-${i}`))
	};
	assert.throws(() => applyImportedRecipeSave(fullKitchen, session, imported), /250 recipes/);
});
