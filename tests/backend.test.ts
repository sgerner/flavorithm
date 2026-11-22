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
	const alicePersonalState = backend.getState(aliceAfterLeave);
	assert.ok(alicePersonalState);
	assert.equal(alicePersonalState.recipes.length, data.seedRecipes.length);
	assert.equal(
		alicePersonalState.recipes.every((recipe: { saved?: boolean }) => recipe.saved === false),
		true
	);
	assert.deepEqual(alicePersonalState.pantry, []);
	assert.deepEqual(alicePersonalState.meals, []);
	assert.deepEqual(alicePersonalState.shopping, []);
	assert.equal(alicePersonalState.preferences.diet, 'Vegetarian');
	assert.deepEqual(alicePersonalState.preferences.cuisines, ['Japanese']);
	assert.deepEqual(
		backend
			.listHouseholdMembers(bobAfterJoin)
			.map(({ id, role }: { id: string; role: 'owner' | 'member' }) => ({ id, role })),
		[{ id: bobAfterJoin.id, role: 'owner' }]
	);
	assert.throws(() => backend.leaveHousehold(bobAfterJoin), { status: 400 });
	assert.throws(() => backend.leaveHousehold(aliceAfterLeave), { status: 400 });
	assert.equal(backend.listHouseholdMembers(bobAfterJoin).length, 1);
	assert.equal(backend.getState(bobAfterJoin)?.pantry[0]?.quantity, 4);
	assert.equal(backend.getState(aliceAfterLeave)?.recipes.length, data.seedRecipes.length);
	assert.equal(backend.getUserFromSession(alice.token)?.householdId, aliceAfterLeave.householdId);
});

test('populated solo kitchens require confirmation before joinHousehold replaces state or consumes invites', async () => {
	const host = await backend.registerUser(
		'Host Kitchen',
		'host-join-guard@example.com',
		'a secure host password'
	);
	const hostState = backend.getState(host.user)!;
	hostState.pantry = [
		{ id: 'host-olive-oil', name: 'Olive oil', quantity: 1, unit: 'bottle', category: 'Oils' }
	];
	backend.saveState(host.user, hostState, {
		ifMatch: backend.getStateEtag(host.user),
		ifNoneMatch: null
	});

	const populatedCases: Array<{ label: string; mutate: (state: any) => void }> = [
		{
			label: 'pantry stock',
			mutate: (state) => {
				state.pantry = [
					{ id: 'beans', name: 'Black beans', quantity: 2, unit: 'cans', category: 'Canned goods' }
				];
			}
		},
		{
			label: 'planned meal',
			mutate: (state) => {
				state.meals = [
					{
						id: 'meal-1',
						date: '2026-11-22',
						slot: 'Dinner',
						recipeId: state.recipes[0].id,
						servings: 2
					}
				];
			}
		},
		{
			label: 'shopping item',
			mutate: (state) => {
				state.shopping = [
					{ id: 'shop-1', name: 'Lemons', quantity: 3, unit: 'whole', checked: false }
				];
			}
		},
		{
			label: 'saved starter recipe',
			mutate: (state) => {
				state.recipes[0].saved = true;
			}
		},
		{
			label: 'custom recipe',
			mutate: (state) => {
				state.recipes.push({
					...state.recipes[0],
					id: 'custom-family-stew',
					title: 'Family Stew',
					saved: false
				});
			}
		}
	];

	const db = backend.getDatabase();
	for (const [index, entry] of populatedCases.entries()) {
		const solo = await backend.registerUser(
			`Solo ${index}`,
			`solo-guard-${index}@example.com`,
			'a secure solo password'
		);
		const oldHouseholdId = solo.user.householdId;
		const soloState = backend.getState(solo.user)!;
		entry.mutate(soloState);
		backend.saveState(solo.user, soloState, {
			ifMatch: backend.getStateEtag(solo.user),
			ifNoneMatch: null
		});

		const invite = backend.createHouseholdInvite(host.user);
		assert.throws(
			() => backend.joinHousehold(solo.user, 'invalid-invite-code'),
			{ status: 400 },
			`invalid invite fails with 400 before confirmation check (${entry.label})`
		);
		assert.throws(
			() => backend.joinHousehold(solo.user, invite.inviteCode),
			{ status: 409, code: 'confirm_replace' },
			`unconfirmed join rejected with 409 for ${entry.label}`
		);

		const inviteRow = db
			.prepare('SELECT uses_remaining FROM household_invites WHERE invite_id = ?')
			.get(invite.inviteId) as { uses_remaining: number } | undefined;
		assert.equal(inviteRow?.uses_remaining, 1, `invite stays unconsumed for ${entry.label}`);
		assert.ok(
			db.prepare('SELECT 1 FROM household_state WHERE household_id = ?').get(oldHouseholdId),
			`solo household_state preserved when unconfirmed for ${entry.label}`
		);

		const joined = backend.joinHousehold(solo.user, invite.inviteCode, { confirmReplace: true });
		assert.equal(joined.householdId, host.user.householdId);
		assert.equal(backend.getState(joined)?.pantry[0]?.name, 'Olive oil');
		const usedInviteRow = db
			.prepare('SELECT uses_remaining FROM household_invites WHERE invite_id = ?')
			.get(invite.inviteId) as { uses_remaining: number } | undefined;
		assert.equal(usedInviteRow?.uses_remaining, 0);
	}
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
		`https://flavorithm.example/?source=mail&reset=${reset.token}`,
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
	assert.match(String(sentBody?.html), /source=mail&amp;reset=/);

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

test('all foreign keys have unconditional leading indexes and auth/household queries avoid table scans', async () => {
	await import('../src/lib/server/oauth-storage.ts');
	await import('../src/lib/server/host-ai.ts');
	await import('../src/lib/server/recipe-covers.ts');
	const database = backend.getDatabase();

	const tables = (
		database
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name);
	assert.equal(tables.length, 17);

	let foreignKeyCount = 0;
	for (const table of tables) {
		const foreignKeys = database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
			id: number;
			seq: number;
			table: string;
			from: string;
			to: string;
		}>;
		const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
			name: string;
			partial: number;
		}>;
		for (const fk of foreignKeys) {
			foreignKeyCount += 1;
			assert.equal(fk.seq, 0, `Expected single-column foreign key on ${table}.${fk.from}`);
			const hasLeadingUnconditionalIndex = indexes.some((index) => {
				if (index.partial !== 0) return false;
				const columns = database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
					seqno: number;
					name: string | null;
				}>;
				return columns.some((column) => column.seqno === 0 && column.name === fk.from);
			});
			assert.equal(
				hasLeadingUnconditionalIndex,
				true,
				`Expected unconditional leading index on ${table}.${fk.from} -> ${fk.table}.${fk.to}`
			);
		}
	}
	assert.equal(foreignKeyCount, 14);

	const queries = [
		'DELETE FROM users WHERE id = ?',
		'DELETE FROM households WHERE id = ?',
		`SELECT invite_id AS inviteId, expires_at AS expiresAt
		 FROM household_invites
		 WHERE household_id = ? AND expires_at > ? AND uses_remaining > 0
		 ORDER BY expires_at`,
		'DELETE FROM sessions WHERE user_id = ?',
		'DELETE FROM password_reset_tokens WHERE user_id = ?',
		'DELETE FROM email_verification_tokens WHERE user_id = ?',
		'DELETE FROM sessions WHERE expires_at <= ?',
		'DELETE FROM password_reset_tokens WHERE expires_at <= ?',
		'DELETE FROM email_verification_tokens WHERE expires_at <= ?',
		'DELETE FROM oidc_login_transactions WHERE expires_at <= ?'
	];

	for (const sql of queries) {
		const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
			parent: number;
			detail: string;
		}>;
		assert.ok(plan.length > 0, `Expected query plan for: ${sql}`);
		assert.equal(
			plan.some((step) => step.detail.startsWith('SEARCH ')),
			true,
			`Expected SEARCH step in plan for ${sql}: ${JSON.stringify(plan)}`
		);
		for (const step of plan) {
			assert.doesNotMatch(step.detail, /\bSCAN\b/, `Unexpected SCAN in plan for: ${sql}`);
			assert.doesNotMatch(
				step.detail,
				/TEMP B-TREE/,
				`Unexpected TEMP B-TREE sort in plan for: ${sql}`
			);
			if (step.parent === 0) {
				assert.match(
					step.detail,
					/^(SEARCH |MULTI-INDEX OR$)/,
					`Expected SEARCH or MULTI-INDEX OR root step for: ${sql}`
				);
			}
		}
	}
});

test('normalized pantry drafts always satisfy validateAppState while raw null quantities are rejected', async () => {
	const { normalizePantryDraft } = await import('../src/lib/kitchen-workflows.ts');
	const state = data.createInitialState();

	const withNullQuantity = structuredClone(state) as Record<string, unknown>;
	(withNullQuantity.pantry as Array<Record<string, unknown>>)[0].quantity = null;
	assert.equal(backend.validateAppState(withNullQuantity), null);

	const normalizedCleared = normalizePantryDraft({
		quantity: null,
		unit: `  ${'x'.repeat(60)}  `,
		category: `  ${'y'.repeat(130)}  `,
		expires: ''
	});
	state.pantry[0] = {
		id: state.pantry[0].id,
		name: state.pantry[0].name,
		...normalizedCleared
	};
	const validated = backend.validateAppState(state);
	assert.ok(validated);
	assert.equal(validated.pantry[0].quantity, 0);
	assert.equal(validated.pantry[0].unit.length, 40);
	assert.equal(validated.pantry[0].category.length, 100);
	assert.equal(validated.pantry[0].expires, undefined);
});
