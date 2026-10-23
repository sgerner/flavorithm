import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const backendModulePath: string = '../src/lib/server/db.ts';
const backend = await import(backendModulePath);
const dataModulePath: string = '../src/lib/data.ts';
const data = await import(dataModulePath);
const exportRouteModulePath: string = '../src/routes/api/export/+server.ts';
const exportRoute = await import(exportRouteModulePath);

test('accounts, shared household state, invites and owner-safe leave', async () => {
	const alice = await backend.registerUser(
		'Alice Example',
		'alice@example.com',
		'correct horse battery'
	);
	const bob = await backend.registerUser(
		'Bob Example',
		'bob@example.com',
		'another secure password'
	);
	for (const account of [alice, bob]) {
		const initial = backend.getState(account.user);
		assert.ok(initial);
		assert.equal(initial.recipes.length, data.seedRecipes.length);
		assert.deepEqual(initial.pantry, []);
		assert.deepEqual(initial.meals, []);
		assert.deepEqual(initial.shopping, []);
		assert.deepEqual(initial.preferences, data.defaultPreferences);
	}

	assert.equal(backend.getUserFromSession(alice.token)?.id, alice.user.id);
	await assert.rejects(() => backend.loginUser('alice@example.com', 'wrong password'), {
		status: 401
	});
	assert.equal(
		(await backend.loginUser('alice@example.com', 'correct horse battery')).user.id,
		alice.user.id
	);

	const state = {
		pantry: [{ id: 'rice', name: 'Rice', quantity: 2, unit: 'cups', category: 'Grains' }],
		recipes: [],
		meals: [],
		shopping: [],
		preferences: {
			...data.defaultPreferences,
			diet: 'Vegetarian',
			cuisines: ['Japanese'],
			onboardingStatus: 'completed'
		}
	};
	assert.throws(() => backend.saveState(alice.user, state, { ifMatch: null, ifNoneMatch: null }), {
		status: 428
	});
	backend.saveState(alice.user, state, {
		ifMatch: backend.getStateEtag(alice.user),
		ifNoneMatch: null
	});
	assert.throws(() => backend.saveState(alice.user, state, { ifMatch: null, ifNoneMatch: '*' }), {
		status: 412
	});
	assert.throws(() => backend.saveState(alice.user, state, { ifMatch: null, ifNoneMatch: null }), {
		status: 428
	});
	const invite = backend.createHouseholdInvite(alice.user);
	const bobAfterJoin = backend.joinHousehold(bob.user, invite.inviteCode);
	assert.throws(() => backend.joinHousehold(alice.user, invite.inviteCode), { status: 400 });
	assert.equal(bobAfterJoin.householdId, alice.user.householdId);
	assert.equal(backend.listHouseholdMembers(bobAfterJoin).length, 2);
	assert.deepEqual(backend.getState(bobAfterJoin)?.preferences, data.defaultPreferences);
	assert.equal(backend.getState(bobAfterJoin)?.pantry[0]?.name, 'Rice');
	assert.deepEqual(backend.getState(alice.user)?.preferences.cuisines, ['Japanese']);
	assert.equal(backend.getState(alice.user)?.preferences.onboardingStatus, 'completed');

	const bobState = {
		...backend.getState(bobAfterJoin)!,
		pantry: [{ ...state.pantry[0], quantity: 4 }]
	};
	const staleAliceTag = backend.getStateEtag(alice.user);
	backend.saveState(bobAfterJoin, bobState, {
		ifMatch: backend.getStateEtag(bobAfterJoin),
		ifNoneMatch: null
	});
	assert.equal(backend.getState(alice.user)?.pantry[0]?.quantity, 4);
	assert.equal(backend.getState(alice.user)?.preferences.diet, 'Vegetarian');
	assert.throws(
		() => backend.saveState(alice.user, state, { ifMatch: staleAliceTag, ifNoneMatch: null }),
		{ status: 412 }
	);

	const aliceAfterLeave = backend.leaveHousehold(alice.user);
	assert.notEqual(aliceAfterLeave.householdId, bobAfterJoin.householdId);
	assert.equal(backend.listHouseholdMembers(bobAfterJoin).length, 1);
	const bobAfterLeave = backend.leaveHousehold(bobAfterJoin);
	assert.equal(backend.listHouseholdMembers(bobAfterLeave).length, 1);
	assert.equal(backend.getState(bobAfterLeave), null);
	assert.equal(backend.getUserFromSession(alice.token)?.householdId, aliceAfterLeave.householdId);
});

test('state validation rejects malformed values and registration enforces the UI password minimum', async () => {
	assert.equal(backend.validateAppState({ pantry: 'free text' }), null);
	assert.equal(
		backend.validateAppState({
			pantry: [],
			recipes: [],
			meals: [],
			shopping: [],
			preferences: {
				diet: '',
				allergies: '',
				maxTime: Number.NaN,
				complexity: '',
				theme: '',
				dark: false,
				provider: '',
				model: ''
			}
		}),
		null
	);
	await assert.rejects(
		() => backend.registerUser('Short Password', 'short@example.com', 'too-short'),
		{ status: 400 }
	);
});

test('account deletion confirms the password and preserves a shared household for remaining members', async () => {
	const owner = await backend.registerUser(
		'Dana Example',
		'dana@example.com',
		'very secure password'
	);
	const member = await backend.registerUser(
		'Eli Example',
		'eli@example.com',
		'another secure password'
	);
	const state = {
		pantry: [{ id: 'oats', name: 'Oats', quantity: 1, unit: 'bag', category: 'Grains' }],
		recipes: [],
		meals: [],
		shopping: [],
		preferences: data.defaultPreferences
	};
	backend.saveState(owner.user, state, {
		ifMatch: backend.getStateEtag(owner.user),
		ifNoneMatch: null
	});
	const invite = backend.createHouseholdInvite(owner.user);
	const memberAfterJoin = backend.joinHousehold(member.user, invite.inviteCode);

	await assert.rejects(() => backend.deleteUserAccount(owner.user.id, 'incorrect password'), {
		status: 401
	});
	await backend.deleteUserAccount(owner.user.id, 'very secure password');
	assert.equal(backend.getUserFromSession(owner.token), null);
	assert.equal(backend.listHouseholdMembers(memberAfterJoin).length, 1);
	assert.equal(backend.getState(memberAfterJoin)?.pantry[0]?.name, 'Oats');
	assert.equal(backend.getState(memberAfterJoin)?.preferences.diet, data.defaultPreferences.diet);
});

test('recipe ratings stay private to each user in a shared household', async () => {
	const owner = await backend.registerUser(
		'Faye Example',
		'faye@example.com',
		'a secure owner password'
	);
	const member = await backend.registerUser(
		'Gus Example',
		'gus@example.com',
		'a secure member password'
	);
	const recipe = {
		id: 'shared-recipe',
		title: 'Shared recipe',
		description: '',
		image: '',
		time: 20,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Test',
		tags: [],
		ingredients: [],
		steps: [],
		nutrition: {
			calories: 1,
			fat: 0,
			saturatedFat: 0,
			sodium: 0,
			carbs: 0,
			fiber: 0,
			sugar: 0,
			protein: 0
		},
		rating: 5
	};
	const state = {
		pantry: [],
		recipes: [recipe],
		meals: [],
		shopping: [],
		preferences: data.defaultPreferences
	};
	backend.saveState(owner.user, state, {
		ifMatch: backend.getStateEtag(owner.user),
		ifNoneMatch: null
	});
	const invite = backend.createHouseholdInvite(owner.user);
	const memberAfterJoin = backend.joinHousehold(member.user, invite.inviteCode);
	assert.equal(backend.getState(owner.user)?.recipes[0]?.rating, 5);
	assert.equal(backend.getState(memberAfterJoin)?.recipes[0]?.rating, undefined);

	const memberState = backend.getState(memberAfterJoin)!;
	memberState.recipes[0]!.rating = 2;
	backend.saveState(memberAfterJoin, memberState, {
		ifMatch: backend.getStateEtag(memberAfterJoin),
		ifNoneMatch: null
	});
	assert.equal(backend.getState(owner.user)?.recipes[0]?.rating, 5);
	assert.equal(backend.getState(memberAfterJoin)?.recipes[0]?.rating, 2);
});

test('password recovery tokens are hashed, one-use, expiring, and revoke old sessions', async () => {
	const account = await backend.registerUser(
		'Hana Example',
		'hana@example.com',
		'current secure password'
	);
	assert.equal(backend.issuePasswordReset('missing@example.com'), null);
	const oldToken = backend.issuePasswordReset(account.user.email)!;
	assert.notEqual(oldToken.token, oldToken.email);
	const reset = backend.issuePasswordReset(account.user.email)!;
	await assert.rejects(() => backend.resetUserPassword(oldToken.token, 'another secure password'), {
		status: 400
	});

	let endpoint = '';
	let sentBody: Record<string, unknown> | undefined;
	const delivered = await backend.sendPasswordResetEmail(
		reset.email,
		`https://flavorithm.example/?reset=${reset.token}`,
		'test-api-key',
		'Flavorithm <kitchen@example.com>',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			endpoint = String(input);
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-api-key');
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(null, { status: 202 });
		}
	);
	assert.equal(delivered, true);
	assert.equal(endpoint, 'https://api.resend.com/emails');
	assert.deepEqual(sentBody?.to, [account.user.email]);

	await backend.resetUserPassword(reset.token, 'replacement secure password');
	assert.equal(backend.getUserFromSession(account.token), null);
	await assert.rejects(() => backend.loginUser(account.user.email, 'current secure password'), {
		status: 401
	});
	assert.equal(
		(await backend.loginUser(account.user.email, 'replacement secure password')).user.id,
		account.user.id
	);
	await assert.rejects(() => backend.resetUserPassword(reset.token, 'third secure password'), {
		status: 400
	});

	const expired = backend.issuePasswordReset(account.user.email)!;
	const now = Date.now;
	Date.now = () => now() + 60 * 60 * 1000 + 1;
	try {
		await assert.rejects(() => backend.resetUserPassword(expired.token, 'fourth secure password'), {
			status: 400
		});
	} finally {
		Date.now = now;
	}
});

test('shared recipes reject executable links and non-positive serving counts', () => {
	const initial = data.createInitialState();
	initial.recipes[0].source = 'javascript:alert(1)';
	assert.equal(backend.validateAppState(initial), null);
	delete initial.recipes[0].source;
	initial.recipes[0].servings = 0;
	assert.equal(backend.validateAppState(initial), null);
});

test('import estimates survive household storage, with bounded notes', async () => {
	const account = await backend.registerUser(
		'Importer',
		'importer@example.com',
		'correct horse battery'
	);
	const state = backend.getState(account.user)!;
	state.recipes[0].importNotes = [
		'Servings estimated at two.',
		'Missing cooking steps were generated.'
	];
	state.recipes[0].provenance = 'web-import';
	state.recipes[1].provenance = 'ai-generated';
	backend.saveState(account.user, state, {
		ifMatch: backend.getStateEtag(account.user),
		ifNoneMatch: null
	});
	const saved = backend.getState(account.user)!;
	assert.deepEqual(saved.recipes[0].importNotes, state.recipes[0].importNotes);
	assert.equal(saved.recipes[0].provenance, 'web-import');
	assert.equal(saved.recipes[1].provenance, 'ai-generated');

	const exportedResponse = await exportRoute.GET({ locals: { user: account.user } } as never);
	const exported = (await exportedResponse.json()) as { state: typeof state };
	assert.equal(exported.state.recipes[0].provenance, 'web-import');
	assert.equal(exported.state.recipes[1].provenance, 'ai-generated');
	assert.deepEqual(exported.state.recipes[0].importNotes, state.recipes[0].importNotes);

	const invalid = structuredClone(state);
	invalid.recipes[0].importNotes = Array.from({ length: 31 }, () => 'Estimate');
	assert.equal(backend.validateAppState(invalid), null);
	const invalidProvenance = structuredClone(state);
	invalidProvenance.recipes[0].provenance = 'unknown';
	assert.equal(backend.validateAppState(invalidProvenance), null);
});

test('reasoning preferences survive persistence and reject invalid budgets', async () => {
	const account = await backend.registerUser(
		'Reasoning Test',
		'reasoning-settings@example.com',
		'a secure test password'
	);
	const state = backend.getState(account.user);
	state.preferences.reasoning = { effort: 'high', enabled: true, budgetTokens: 2048 };
	backend.saveState(account.user, state, {
		ifMatch: backend.getStateEtag(account.user),
		ifNoneMatch: null
	});
	assert.deepEqual(
		backend.getState(account.user).preferences.reasoning,
		state.preferences.reasoning
	);
	state.preferences.reasoning.budgetTokens = -1;
	assert.equal(backend.validateAppState(state), null);
});
