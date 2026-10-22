import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const backendModulePath: string = '../src/lib/server/db.ts';
const backend = await import(backendModulePath);
const householdRoute = await import('../src/routes/api/household/+server.ts');
const authRoute = await import('../src/routes/api/auth/+server.ts');

function postEvent(path: string, locals: Record<string, unknown>, body: unknown) {
	return {
		request: new Request(`https://flavorithm.example${path}`, {
			method: 'POST',
			headers: { origin: 'https://flavorithm.example', 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		locals,
		getClientAddress: () => '192.0.2.10',
		cookies: {
			get: () => undefined,
			set: () => undefined,
			delete: () => undefined
		}
	};
}

test('household management is owner-only and removed members get a private initialized kitchen', async () => {
	const owner = await backend.registerUser(
		'Owner Example',
		'owner-controls@example.com',
		'a secure owner password'
	);
	const member = await backend.registerUser(
		'Member Example',
		'member-controls@example.com',
		'a secure member password'
	);
	const outsider = await backend.registerUser(
		'Outsider Example',
		'outsider-controls@example.com',
		'a secure outsider password'
	);

	const personal = backend.getState(member.user)!;
	personal.preferences.diet = 'Vegetarian';
	personal.preferences.cuisines = ['Korean'];
	backend.saveState(member.user, personal, {
		ifMatch: backend.getStateEtag(member.user),
		ifNoneMatch: null
	});

	const firstInvite = backend.createHouseholdInvite(owner.user);
	assert.equal(firstInvite.inviteId.length, 64);
	assert.notEqual(firstInvite.inviteId, firstInvite.inviteCode);
	assert.deepEqual(
		backend
			.listHouseholdInvites(owner.user)
			.map((invite: { inviteId: string; expiresAt: number }) => ({ ...invite })),
		[{ inviteId: firstInvite.inviteId, expiresAt: firstInvite.expiresAt }]
	);
	assert.deepEqual(
		backend
			.listHouseholdMembers(owner.user)
			.map(({ id, role }: { id: string; role: 'owner' | 'member' }) => ({ id, role })),
		[{ id: owner.user.id, role: 'owner' }]
	);
	const memberAfterJoin = backend.joinHousehold(member.user, firstInvite.inviteCode);
	assert.throws(() => backend.createHouseholdInvite(memberAfterJoin), { status: 403 });
	assert.deepEqual(
		backend
			.listHouseholdMembers(owner.user)
			.map(({ id, role }: { id: string; role: 'owner' | 'member' }) => ({ id, role })),
		[
			{ id: owner.user.id, role: 'owner' },
			{ id: member.user.id, role: 'member' }
		]
	);
	assert.throws(
		() => backend.saveState(member.user, personal, { ifMatch: 'stale', ifNoneMatch: null }),
		{ status: 409 }
	);
	assert.throws(() => backend.removeHouseholdMember(memberAfterJoin, owner.user.id), {
		status: 403
	});
	assert.throws(() => backend.removeHouseholdMember(owner.user, outsider.user.id), { status: 403 });
	assert.throws(() => backend.removeHouseholdMember(owner.user, owner.user.id), { status: 400 });

	const removed = backend.removeHouseholdMember(owner.user, member.user.id);
	assert.notEqual(removed.householdId, owner.user.householdId);
	assert.equal(backend.getUserFromSession(member.token)?.householdId, removed.householdId);
	assert.equal(backend.listHouseholdMembers(owner.user).length, 1);
	const privateKitchen = backend.getState(removed);
	assert.ok(privateKitchen, 'the departing member receives initialized kitchen state');
	assert.deepEqual(privateKitchen.pantry, []);
	assert.ok(privateKitchen.recipes.length > 0);
	assert.equal(privateKitchen.preferences.diet, 'Vegetarian');
	assert.deepEqual(privateKitchen.preferences.cuisines, ['Korean']);
	assert.throws(
		() => backend.saveState(memberAfterJoin, personal, { ifMatch: 'stale', ifNoneMatch: null }),
		{ status: 409 }
	);

	const revokeTarget = backend.createHouseholdInvite(owner.user);
	backend.revokeHouseholdInvite(owner.user, revokeTarget.inviteId);
	assert.equal(backend.listHouseholdInvites(owner.user).length, 0);
	assert.throws(() => backend.joinHousehold(outsider.user, revokeTarget.inviteCode), {
		status: 400
	});
	assert.throws(() => backend.revokeHouseholdInvite(memberAfterJoin, firstInvite.inviteId), {
		status: 409
	});
});

test('email verification tokens are hashed, one-use, expiring, and delivered through Resend', async () => {
	const account = await backend.registerUser(
		'Verify Example',
		'verify-controls@example.com',
		'a secure verification password'
	);
	assert.equal(account.user.emailVerified, false);
	assert.equal(
		(await backend.loginUser(account.user.email, 'a secure verification password')).user
			.emailVerified,
		false
	);
	assert.throws(() => backend.issueEmailVerification('missing-user'), { status: 401 });
	const verification = backend.issueEmailVerification(account.user.id)!;
	const stored = backend
		.getDatabase()
		.prepare('SELECT token_hash FROM email_verification_tokens WHERE user_id = ?')
		.get(account.user.id) as { token_hash: string };
	assert.equal(stored.token_hash, createHash('sha256').update(verification.token).digest('hex'));
	assert.notEqual(stored.token_hash, verification.token);

	let endpoint = '';
	let sentBody: Record<string, unknown> | undefined;
	const delivered = await backend.sendEmailVerificationEmail(
		verification.email,
		`https://flavorithm.example/?verify=${verification.token}`,
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
	assert.match(String(sentBody?.text), new RegExp(verification.token));

	const verified = backend.verifyEmailToken(verification.token);
	assert.equal(verified.emailVerified, true);
	assert.equal(backend.getUserFromSession(account.token)?.emailVerified, true);
	assert.throws(() => backend.verifyEmailToken(verification.token), { status: 400 });

	const expiringAccount = await backend.registerUser(
		'Expire Example',
		'expire-controls@example.com',
		'a secure expiring password'
	);
	const expired = backend.issueEmailVerification(expiringAccount.user.id)!;
	const now = Date.now;
	Date.now = () => now() + 24 * 60 * 60 * 1000 + 1;
	try {
		assert.throws(() => backend.verifyEmailToken(expired.token), { status: 400 });
	} finally {
		Date.now = now;
	}
});

test('persistence accepts optional meal, shopping, and recipe metadata', async () => {
	const account = await backend.registerUser(
		'Metadata Example',
		'metadata-controls@example.com',
		'a secure metadata password'
	);
	const state = backend.getState(account.user)!;
	Object.assign(state.recipes[0], { nutritionStale: true });
	state.meals.push({
		id: 'completed-meal',
		date: '2026-10-22',
		slot: 'dinner',
		recipeId: state.recipes[0].id,
		servings: 2,
		completedAt: '2026-10-22T18:30:00.000Z',
		leftoverServings: 1
	});
	state.shopping.push({
		id: 'generated-item',
		name: 'Rice',
		quantity: 1,
		unit: 'cup',
		checked: false,
		sourceKey: 'meal:completed-meal:rice'
	});
	assert.ok(backend.validateAppState(state));
	backend.saveState(account.user, state, {
		ifMatch: backend.getStateEtag(account.user),
		ifNoneMatch: null
	});
	const saved = backend.getState(account.user)!;
	assert.equal((saved.recipes[0] as Record<string, unknown>).nutritionStale, true);
	assert.equal((saved.meals[0] as Record<string, unknown>).completedAt, '2026-10-22T18:30:00.000Z');
	assert.equal((saved.meals[0] as Record<string, unknown>).leftoverServings, 1);
	assert.equal(
		(saved.shopping[0] as Record<string, unknown>).sourceKey,
		'meal:completed-meal:rice'
	);
});

test('auth and household endpoints expose status, hashed invites, and one-use verification', async () => {
	const owner = await backend.registerUser(
		'Route Owner',
		'route-owner@example.com',
		'a secure route owner password'
	);
	const member = await backend.registerUser(
		'Route Member',
		'route-member@example.com',
		'a secure route member password'
	);
	const householdGet = await householdRoute.GET({ locals: { user: owner.user } } as never);
	assert.equal(householdGet.status, 200);
	assert.deepEqual(await householdGet.json(), {
		members: [{ id: owner.user.id, name: owner.user.name, email: owner.user.email, role: 'owner' }],
		invites: [],
		canManage: true
	});

	const createdResponse = await householdRoute.POST(
		postEvent('/api/household', { user: owner.user }, { action: 'createInvite' }) as never
	);
	const created = (await createdResponse.json()) as {
		inviteId: string;
		inviteCode: string;
		expiresAt: number;
	};
	assert.equal(createdResponse.status, 200);
	assert.ok(created.inviteCode);
	assert.equal(created.inviteId.length, 64);
	const listed = await householdRoute.GET({ locals: { user: owner.user } } as never);
	const listedData = (await listed.json()) as { invites: Array<Record<string, unknown>> };
	assert.deepEqual(listedData.invites, [
		{ inviteId: created.inviteId, expiresAt: created.expiresAt }
	]);
	assert.equal(JSON.stringify(listedData).includes(created.inviteCode), false);
	backend.joinHousehold(member.user, created.inviteCode);
	const removeResponse = await householdRoute.POST(
		postEvent(
			'/api/household',
			{ user: owner.user },
			{ action: 'removeMember', memberId: member.user.id }
		) as never
	);
	assert.equal(removeResponse.status, 200);
	assert.equal(
		backend.getUserFromSession(member.token)?.householdId === owner.user.householdId,
		false
	);

	const verification = backend.issueEmailVerification(owner.user.id)!;
	const verificationResponse = await authRoute.POST(
		postEvent('/api/auth', {}, { action: 'verifyEmail', token: verification.token }) as never
	);
	assert.equal(verificationResponse.status, 200);
	assert.equal(
		((await verificationResponse.json()) as { user: { emailVerified: boolean } }).user
			.emailVerified,
		true
	);
	const authStatus = await authRoute.GET({
		locals: { user: backend.getUserFromSession(owner.token) }
	} as never);
	const authStatusData = (await authStatus.json()) as {
		user: { emailVerified: boolean };
		capabilities: { emailDelivery: boolean; recipeSearch: boolean };
	};
	assert.equal(authStatusData.user.emailVerified, true);
	assert.equal(typeof authStatusData.capabilities.emailDelivery, 'boolean');
	assert.equal(typeof authStatusData.capabilities.recipeSearch, 'boolean');
	assert.equal(JSON.stringify(authStatusData).includes(verification.token), false);
});
