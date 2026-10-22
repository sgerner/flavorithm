import test from 'node:test';
import assert from 'node:assert/strict';
process.env.FLAVORITHM_DB_PATH = ':memory:';
const backendPath: string = '../src/lib/server/db.ts';
const backend = await import(backendPath);
const route = await import('../src/routes/api/state/+server.ts');

test('state writes reject snapshots from another account or household even with a fresh ETag', async () => {
	const { user } = await backend.registerUser(
		'Queue user',
		'queue@example.test',
		'a sufficiently long password'
	);
	const state = backend.getState(user);
	const etag = backend.getStateEtag(user);
	for (const mismatch of [
		{ expectedUserId: 'another' },
		{ expectedHouseholdId: 'departed-home' }
	]) {
		const response = await route.PUT({
			locals: { user },
			request: new Request('https://flavorithm.example/api/state', {
				method: 'PUT',
				headers: {
					origin: 'https://flavorithm.example',
					'content-type': 'application/json',
					'if-match': etag
				},
				body: JSON.stringify({ state, ...mismatch })
			})
		} as never);
		assert.equal(response.status, 409);
		assert.equal(backend.getStateEtag(user), etag);
	}
	const response = await route.GET({ locals: { user } } as never);
	const result = await response.json();
	assert.equal(result.userId, user.id);
	assert.equal(result.householdId, user.householdId);
});
