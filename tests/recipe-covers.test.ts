import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { parse, type AST } from 'svelte/compiler';
import { recipeImageError, recipePlaceholder } from '../src/lib/recipe-cover.ts';
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
	const directResponse = await download.GET(event as never);
	assert.equal(directResponse.status, 200);
	assert.equal(directResponse.headers.get('cache-control'), 'private, no-store');
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

	const recipe = { id: 'cover-fail', title: 'Tomato pasta' };
	let currentAttr = `/api/recipe-covers/${'a'.repeat(64)}`;
	let assignments = 0;
	const img = {
		getAttribute: (name: string) => (name === 'src' ? currentAttr : null),
		set src(value: string) {
			currentAttr = value;
			assignments++;
		},
		get src() {
			return currentAttr;
		}
	};
	recipeImageError({ currentTarget: img } as unknown as Event, recipe);
	assert.equal(currentAttr, '/recipe-covers/pasta.svg');
	assert.equal(assignments, 1);
	recipeImageError({ currentTarget: img } as unknown as Event, recipe);
	assert.equal(assignments, 1);
});

test('offscreen and mobile recipe covers lazy load, decode asynchronously, declare dimensions, and suppress hidden mobile thumbnails', () => {
	const pageSource = readFileSync('src/routes/+page.svelte', 'utf8');
	const appCss = readFileSync('src/app.css', 'utf8');
	const ast = parse(pageSource, { modern: true });

	type ElementRecord = {
		node: AST.RegularElement;
		ancestors: AST.SvelteNode[];
	};

	const elements: ElementRecord[] = [];
	function walk(node: unknown, ancestors: AST.SvelteNode[] = []): void {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item, ancestors);
			return;
		}
		const svelteNode = node as AST.SvelteNode & Record<string, unknown>;
		const nextAncestors =
			typeof svelteNode.type === 'string' ? [...ancestors, svelteNode] : ancestors;
		if (svelteNode.type === 'RegularElement') {
			elements.push({ node: svelteNode as AST.RegularElement, ancestors });
		}
		for (const [key, value] of Object.entries(svelteNode)) {
			if (key === 'parent') continue;
			if (value && typeof value === 'object') walk(value, nextAncestors);
		}
	}
	walk(ast.fragment);

	function staticAttr(el: AST.RegularElement, name: string): string | undefined {
		const attr = el.attributes.find((item) => item.type === 'Attribute' && item.name === name);
		if (!attr || attr.type !== 'Attribute' || !Array.isArray(attr.value)) return undefined;
		const first = attr.value[0];
		return attr.value.length === 1 && first?.type === 'Text' ? first.data : undefined;
	}

	function rawAttr(el: AST.RegularElement, name: string): string | undefined {
		const attr = el.attributes.find((item) => item.type === 'Attribute' && item.name === name);
		if (!attr) return undefined;
		return pageSource.slice(attr.start, attr.end);
	}

	function findCoverInContainer(className: string): ElementRecord {
		const container = elements.find(({ node }) =>
			(staticAttr(node, 'class') ?? '').split(/\s+/).includes(className)
		);
		assert.ok(container, `expected .${className} container in +page.svelte`);
		const img = elements.find(
			(record) => record.node.name === 'img' && record.ancestors.includes(container.node)
		);
		assert.ok(img, `expected cover <img> inside .${className}`);
		return {
			node: img.node,
			ancestors: img.ancestors.slice(img.ancestors.indexOf(container.node) + 1)
		};
	}

	function assertFallbacks(el: AST.RegularElement): void {
		assert.match(rawAttr(el, 'src') ?? '', /recipe\.image\s*\|\|\s*recipePlaceholder\(recipe\)/);
		assert.match(rawAttr(el, 'onerror') ?? '', /recipeImageError\(event,\s*recipe\)/);
	}

	// 1. .pick-list scrollport covers match 75x60 CSS and defer offscreen loads.
	const pickListImg = findCoverInContainer('pick-list');
	assert.equal(staticAttr(pickListImg.node, 'loading'), 'lazy');
	assert.equal(staticAttr(pickListImg.node, 'decoding'), 'async');
	assert.equal(staticAttr(pickListImg.node, 'width'), '75');
	assert.equal(staticAttr(pickListImg.node, 'height'), '60');
	assertFallbacks(pickListImg.node);
	assert.match(appCss, /\.pick-list img\s*\{[^}]*height:\s*60px;[^}]*width:\s*75px;/s);

	// 2. .cooked-history-row covers match 54x48 component CSS and defer offscreen loads.
	const historyImg = findCoverInContainer('cooked-history-row');
	assert.equal(staticAttr(historyImg.node, 'loading'), 'lazy');
	assert.equal(staticAttr(historyImg.node, 'decoding'), 'async');
	assert.equal(staticAttr(historyImg.node, 'width'), '54');
	assert.equal(staticAttr(historyImg.node, 'height'), '48');
	assertFallbacks(historyImg.node);
	assert.match(pageSource, /\.cooked-history-row img\s*\{[^}]*width:\s*54px;[^}]*height:\s*48px;/s);

	// 3. .calendar-meal covers are suppressed on mobile (<= 650px) and lazy/sized above 650px.
	const calendarImg = findCoverInContainer('calendar-meal');
	assert.equal(staticAttr(calendarImg.node, 'loading'), 'lazy');
	assert.equal(staticAttr(calendarImg.node, 'decoding'), 'async');
	assert.equal(staticAttr(calendarImg.node, 'width'), '180');
	assert.equal(staticAttr(calendarImg.node, 'height'), '65');
	assertFallbacks(calendarImg.node);
	const mobileGuardIf = calendarImg.ancestors.find((ancestor) => ancestor.type === 'IfBlock');
	assert.ok(
		mobileGuardIf && mobileGuardIf.type === 'IfBlock',
		'calendar cover must be conditional'
	);
	assert.equal(mobileGuardIf.test.type, 'UnaryExpression');
	assert.equal(mobileGuardIf.test.operator, '!');
	assert.equal(mobileGuardIf.test.argument.type, 'Identifier');
	assert.equal(mobileGuardIf.test.argument.name, 'mobileCalendar');
	assert.match(appCss, /\.calendar-meal img\s*\{[^}]*width:\s*100%;[^}]*height:\s*65px;/s);
	assert.match(
		appCss,
		/@media \(max-width: 650px\)\s*\{[\s\S]*?\.calendar-meal img\s*\{\s*display:\s*none;\s*\}/
	);

	// 4. .recipe-grid (.recipe-card) keeps eager loading for the first row.
	const gridCardImg = findCoverInContainer('recipe-card');
	assert.match(rawAttr(gridCardImg.node, 'loading') ?? '', /i\s*>\s*2\s*\?\s*'lazy'\s*:\s*'eager'/);
	assertFallbacks(gridCardImg.node);

	// 5. Execute the real mobileCalendar + matchMedia lifecycle from +page.svelte against mock windows.
	assert.ok(ast.instance, 'expected instance <script> in +page.svelte');
	const scriptSource = pageSource.slice(ast.instance.start, ast.instance.end);
	const stateDecl = scriptSource.match(/let mobileCalendar = \$state\([\s\S]*?\);/)?.[0];
	const mountSetup = scriptSource.match(
		/const calendarMedia =[\s\S]*?calendarMedia\?\.addEventListener\('change', calendarMediaChanged\);/
	)?.[0];
	const mountCleanup = scriptSource.match(
		/calendarMedia\?\.removeEventListener\('change', calendarMediaChanged\);/
	)?.[0];
	assert.ok(stateDecl && mountSetup && mountCleanup, 'expected mobileCalendar media query wiring');
	assert.match(stateDecl, /typeof window\.matchMedia === 'function'/);
	assert.match(mountSetup, /typeof window\.matchMedia === 'function'/);

	function mountCalendarMediaHarness(win: unknown) {
		const context: Record<string, unknown> = {
			window: win,
			$state: <T>(initial: T) => initial
		};
		const api = runInNewContext(
			`${stateDecl}
			function mount() {
				${mountSetup}
				return () => {
					${mountCleanup}
				};
			}
			({ get mobileCalendar() { return mobileCalendar; }, mount });`,
			context
		) as { readonly mobileCalendar: boolean; mount: () => () => void };
		return api;
	}

	// Guard when window.matchMedia is unavailable.
	const withoutMatchMedia = mountCalendarMediaHarness({});
	assert.equal(withoutMatchMedia.mobileCalendar, false);
	const noopCleanup = withoutMatchMedia.mount();
	assert.equal(withoutMatchMedia.mobileCalendar, false);
	noopCleanup();

	// Suppresses below/at 650px, mounts immediately when resized past 650px, and cleans up on unmount.
	let matches = true;
	const listeners = new Set<() => void>();
	const queries: string[] = [];
	const withMatchMedia = mountCalendarMediaHarness({
		matchMedia(query: string) {
			queries.push(query);
			return {
				get matches() {
					return matches;
				},
				addEventListener(event: string, listener: () => void) {
					if (event === 'change') listeners.add(listener);
				},
				removeEventListener(event: string, listener: () => void) {
					if (event === 'change') listeners.delete(listener);
				}
			};
		}
	});
	assert.equal(withMatchMedia.mobileCalendar, true);
	const cleanup = withMatchMedia.mount();
	assert.ok(queries.every((q) => q === '(max-width: 650px)'));
	assert.equal(listeners.size, 1);
	assert.equal(withMatchMedia.mobileCalendar, true);

	matches = false;
	for (const listener of listeners) listener();
	assert.equal(withMatchMedia.mobileCalendar, false);

	matches = true;
	for (const listener of listeners) listener();
	assert.equal(withMatchMedia.mobileCalendar, true);

	cleanup();
	assert.equal(listeners.size, 0);
	matches = false;
	for (const listener of listeners) listener();
	assert.equal(withMatchMedia.mobileCalendar, true);
});

test('solo recipe covers block solo leave and unconfirmed household join without losing bytes or invites', async () => {
	const { user: solo } = await backend.registerUser(
		'Solo Cover Cook',
		'solo-cover@example.com',
		'secure solo cover password'
	);
	const { user: partner } = await backend.registerUser(
		'Partner Cook',
		'partner-cover@example.com',
		'secure partner cover password'
	);
	const soloHouseholdId = solo.householdId;
	const coverPath = await storeCover(
		soloHouseholdId,
		await sharp({ create: { width: 40, height: 40, channels: 3, background: '#557744' } })
			.jpeg()
			.toBuffer()
	);
	const coverId = coverPath.split('/').at(-1)!;
	assert.ok(readCover(soloHouseholdId, coverId));

	assert.throws(() => backend.leaveHousehold(solo), { status: 400 });
	assert.ok(readCover(soloHouseholdId, coverId));

	const invite = backend.createHouseholdInvite(partner);
	assert.throws(() => backend.joinHousehold(solo, invite.inviteCode), {
		status: 409,
		code: 'confirm_replace'
	});
	assert.ok(readCover(soloHouseholdId, coverId));

	const inviteRow = backend
		.getDatabase()
		.prepare('SELECT uses_remaining FROM household_invites WHERE invite_id = ?')
		.get(invite.inviteId) as { uses_remaining: number };
	assert.equal(inviteRow.uses_remaining, 1);

	const joined = backend.joinHousehold(solo, invite.inviteCode, { confirmReplace: true });
	assert.equal(joined.householdId, partner.householdId);
	assert.equal(readCover(soloHouseholdId, coverId), undefined);
});
