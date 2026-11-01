import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { recipePlaceholder } from '../src/lib/recipe-cover.ts';
import { COVER_PATH, MAX_COVER_BYTES } from '../src/lib/cover-upload.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.FLAVORITHM_AUTH_MODE = 'local';
const backend = await import('../src/lib/server/db.ts');
const { handle } = await import('../src/hooks.server.ts');
const { storeCover, readCover } = await import('../src/lib/server/recipe-covers.ts');
const upload = await import('../src/routes/api/recipe-covers/+server.ts');
const download = await import('../src/routes/api/recipe-covers/[id]/+server.ts');

test('covers are validated, resized, deduplicated, household private, and survive state validation', async () => {
	const { user, token } = await backend.registerUser(
		'Cover owner',
		'cover@example.com',
		'secure password for covers'
	);
	const { user: other } = await backend.registerUser(
		'Other owner',
		'other@example.com',
		'another secure password'
	);
	const bytes = await sharp({
		create: { width: 1600, height: 800, channels: 3, background: '#b65c42' }
	})
		.jpeg()
		.toBuffer();
	const image = await storeCover(user.householdId, bytes);
	assert.match(image, COVER_PATH);
	assert.equal(await storeCover(user.householdId, bytes), image);
	const id = image.split('/').at(-1)!;
	assert.equal(readCover(other.householdId, id), undefined);
	const stored = readCover(user.householdId, id)!;
	const metadata = await sharp(stored).metadata();
	assert.equal(metadata.width, 1200);
	assert.equal(metadata.height, 600);
	assert.equal(metadata.exif, undefined);
	const state = backend.getState(user)!;
	state.recipes[0].image = image;
	assert.ok(backend.validateAppState(state));
	for (const invalid of [
		'/api/recipe-covers/../../secret',
		'data:image/jpeg;base64,AAAA',
		'/other.svg'
	]) {
		state.recipes[0].image = invalid;
		assert.equal(backend.validateAppState(state), null);
	}
	await assert.rejects(storeCover(user.householdId, new Uint8Array(MAX_COVER_BYTES + 1)), {
		status: 413
	});
	await assert.rejects(storeCover(user.householdId, new Uint8Array([255, 216, 255, 0, 255, 217])), {
		status: 400
	});
	const event = { locals: { user }, params: { id } };
	assert.equal((await download.GET(event as never)).status, 200);
	const coverUrl = `https://flavorithm.example/api/recipe-covers/${id}`;
	const hookedResponse = await handle({
		event: {
			request: new Request(coverUrl),
			url: new URL(coverUrl),
			cookies: { get: (name: string) => (name === 'flavorithm_session' ? token : undefined) },
			locals: { user: null, authMode: 'invalid' }
		},
		resolve: async (resolvedEvent: { locals: { user: typeof user } }) =>
			download.GET({ ...resolvedEvent, params: { id } } as never)
	} as never);
	assert.equal(hookedResponse.headers.get('cache-control'), 'private, no-store');
	assert.equal((await download.GET({ ...event, locals: { user: other } } as never)).status, 404);
	assert.equal((await download.GET({ ...event, locals: {} } as never)).status, 401);
	const post = (body: Uint8Array, origin = 'http://localhost') =>
		upload.POST({
			locals: { user },
			request: new Request('http://localhost/api/recipe-covers', {
				method: 'POST',
				headers: { Origin: origin, 'Content-Type': 'image/jpeg' },
				body: new Uint8Array(body)
			})
		} as never);
	assert.equal((await post(bytes)).status, 200);
	assert.equal((await post(bytes, 'https://other.example')).status, 403);
	assert.equal((await post(new Uint8Array(MAX_COVER_BYTES + 1))).status, 413);
});

test('old unused uploads are reclaimed while saved covers and recent drafts are retained', async () => {
	const { user } = await backend.registerUser(
		'Cleanup owner',
		'cleanup@example.com',
		'secure cleanup password'
	);
	const make = async (background: string) =>
		storeCover(
			user.householdId,
			await sharp({ create: { width: 10, height: 10, channels: 3, background } })
				.jpeg()
				.toBuffer()
		);
	const saved = await make('red');
	const orphan = await make('blue');
	const state = backend.getState(user)!;
	state.recipes[0].image = saved;
	backend.saveState(user, state, { ifMatch: backend.getStateEtag(user), ifNoneMatch: null });
	backend
		.getDatabase()
		.prepare('UPDATE recipe_covers SET created_at = 0 WHERE household_id = ?')
		.run(user.householdId);
	const recent = await make('green');
	await make('yellow');
	assert.ok(readCover(user.householdId, saved.split('/').at(-1)!));
	assert.equal(readCover(user.householdId, orphan.split('/').at(-1)!), undefined);
	assert.ok(readCover(user.householdId, recent.split('/').at(-1)!));
});

test('fallbacks are stable, local, themed, and varied', () => {
	assert.equal(recipePlaceholder({ id: '1', title: 'Tomato pasta' }), '/recipe-covers/pasta.svg');
	assert.equal(recipePlaceholder({ id: '2', title: 'Garden salad' }), '/recipe-covers/garden.svg');
	const paths = Array.from({ length: 30 }, (_, i) =>
		recipePlaceholder({ id: String(i), title: 'Family favorite' })
	);
	assert.ok(new Set(paths).size >= 4);
	assert.deepEqual(
		paths,
		Array.from({ length: 30 }, (_, i) =>
			recipePlaceholder({ id: String(i), title: 'Family favorite' })
		)
	);
});
