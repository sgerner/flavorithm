import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const scriptPath = resolve('scripts/verify-publish-gates.mjs');
const containerWorkflowPath = resolve('.github/workflows/container.yml');
const defaultSha = '0123456789abcdef0123456789abcdef01234567';
const defaultRepository = 'sgerner/flavorithm';
const testGithubToken = 'ghs_test_publish_gate_secret_token';
const testRegistryToken = 'v1.ghcr_test_pull_bearer_token';

type WorkflowRunFixture = {
	id?: number;
	name?: string;
	path: string;
	head_sha?: string;
	head_branch?: string;
	event?: string;
	status: string;
	conclusion: string | null;
	run_number: number;
	run_attempt?: number;
	head_repository?: {
		full_name?: string;
		fork?: boolean;
	};
};

type MockServerConfig = {
	pages?: WorkflowRunFixture[][];
	githubStatus?: number;
	ghcrTokenStatus?: number;
	ghcrManifestStatus?: number;
	expectedRepository?: string;
	expectedActor?: string;
};

function buildEvent(overrides: Record<string, unknown> = {}) {
	return {
		action: 'completed',
		repository: { full_name: defaultRepository },
		workflow_run: {
			id: 1001,
			name: 'CI',
			path: '.github/workflows/ci.yml',
			head_branch: 'main',
			head_sha: defaultSha,
			event: 'push',
			status: 'completed',
			conclusion: 'success',
			run_number: 12,
			head_repository: {
				full_name: defaultRepository,
				fork: false
			},
			...overrides
		}
	};
}

function makeRun(
	workflow: 'CI' | 'Security',
	overrides: Partial<WorkflowRunFixture> = {}
): WorkflowRunFixture {
	return {
		id: workflow === 'CI' ? 100 : 200,
		name: workflow,
		path: workflow === 'CI' ? '.github/workflows/ci.yml' : '.github/workflows/security.yml',
		head_sha: defaultSha,
		head_branch: 'main',
		event: 'push',
		status: 'completed',
		conclusion: 'success',
		run_number: 1,
		run_attempt: 1,
		head_repository: {
			full_name: defaultRepository,
			fork: false
		},
		...overrides
	};
}

async function withMockApis<T>(
	config: MockServerConfig,
	fn: (context: {
		baseUrl: string;
		requests: Array<{
			method: string;
			url: string;
			authorization: string | null;
			accept: string | null;
		}>;
	}) => Promise<T>
): Promise<T> {
	const requests: Array<{
		method: string;
		url: string;
		authorization: string | null;
		accept: string | null;
	}> = [];
	const pages = config.pages ?? [[]];
	const expectedRepo = (config.expectedRepository ?? defaultRepository).toLowerCase();
	const expectedActor = config.expectedActor ?? 'sgerner';

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);
		requests.push({
			method: req.method ?? 'GET',
			url: requestUrl.pathname + requestUrl.search,
			authorization: req.headers.authorization ?? null,
			accept: req.headers.accept ?? null
		});

		if (requestUrl.pathname.endsWith('/actions/runs')) {
			if (config.githubStatus && config.githubStatus !== 200) {
				res.writeHead(config.githubStatus, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ message: 'GitHub API error' }));
				return;
			}
			assert.equal(req.headers.authorization, `Bearer ${testGithubToken}`);
			const pageNumber = Number(requestUrl.searchParams.get('page') ?? '1');
			const pageRuns = pages[pageNumber - 1] ?? [];
			const totalCount = pages.reduce((sum, page) => sum + page.length, 0);
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (pageNumber < pages.length) {
				const nextUrl = new URL(requestUrl.href);
				nextUrl.searchParams.set('page', String(pageNumber + 1));
				headers.Link = `<${requestUrl.origin}${requestUrl.pathname}?page=1>; rel="first", <${nextUrl.href}>; rel="next"`;
			}
			res.writeHead(200, headers);
			res.end(JSON.stringify({ total_count: totalCount, workflow_runs: pageRuns }));
			return;
		}

		if (requestUrl.pathname === '/token') {
			if (config.ghcrTokenStatus && config.ghcrTokenStatus !== 200) {
				res.writeHead(config.ghcrTokenStatus, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
				return;
			}
			const expectedBasic =
				'Basic ' + Buffer.from(`${expectedActor}:${testGithubToken}`, 'utf8').toString('base64');
			assert.equal(req.headers.authorization, expectedBasic);
			assert.equal(requestUrl.searchParams.get('service'), 'ghcr.io');
			assert.equal(requestUrl.searchParams.get('scope'), `repository:${expectedRepo}:pull`);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ token: testRegistryToken }));
			return;
		}

		if (requestUrl.pathname.startsWith('/v2/')) {
			assert.equal(req.headers.authorization, `Bearer ${testRegistryToken}`);
			const status = config.ghcrManifestStatus ?? 404;
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(
				status === 200
					? JSON.stringify({ schemaVersion: 2 })
					: JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] })
			);
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ message: 'Unhandled mock route' }));
	});

	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	const { port } = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		return await fn({ baseUrl, requests });
	} finally {
		await new Promise<void>((resolveClose, rejectClose) =>
			server.close((error) => (error ? rejectClose(error) : resolveClose()))
		);
	}
}

async function runGate(options: {
	event?: unknown;
	env?: Record<string, string | undefined>;
}): Promise<{ status: number | null; stdout: string; stderr: string; outputFile: string }> {
	const directory = mkdtempSync(join(tmpdir(), 'flavorithm-publish-gate-'));
	const eventPath = join(directory, 'event.json');
	const outputPath = join(directory, 'github-output.txt');
	try {
		if (options.event !== undefined) {
			writeFileSync(eventPath, JSON.stringify(options.event), 'utf8');
		}
		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			GITHUB_TOKEN: testGithubToken,
			GITHUB_REPOSITORY: defaultRepository,
			GITHUB_ACTOR: 'sgerner',
			GITHUB_EVENT_NAME: 'workflow_run',
			GITHUB_EVENT_PATH: eventPath,
			GITHUB_OUTPUT: outputPath,
			...options.env
		};
		for (const [key, value] of Object.entries(childEnv)) {
			if (value === undefined) delete childEnv[key];
		}

		const { status, stdout, stderr } = await new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
		}>((resolveRun, rejectRun) => {
			const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath], {
				env: childEnv,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let out = '';
			let err = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => (out += chunk));
			child.stderr.on('data', (chunk) => (err += chunk));
			child.on('error', rejectRun);
			child.on('close', (code) => resolveRun({ status: code, stdout: out, stderr: err }));
		});

		const outputFile = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
		return { status, stdout, stderr, outputFile };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test('publish gate sets ready=true when CI and Security succeeded and GHCR lacks the commit tag', async () => {
	const mixedCaseRepo = 'Sgerner/Flavorithm';
	await withMockApis(
		{
			expectedRepository: mixedCaseRepo,
			expectedActor: 'sgerner',
			pages: [
				[
					makeRun('CI', { head_repository: { full_name: mixedCaseRepo, fork: false } }),
					makeRun('Security', { head_repository: { full_name: mixedCaseRepo, fork: false } })
				]
			],
			ghcrManifestStatus: 404
		},
		async ({ baseUrl, requests }) => {
			const result = await runGate({
				event: {
					action: 'completed',
					repository: { full_name: mixedCaseRepo },
					workflow_run: {
						id: 1001,
						name: 'Security',
						path: '.github/workflows/security.yml',
						head_branch: 'main',
						head_sha: defaultSha,
						event: 'push',
						status: 'completed',
						conclusion: 'success',
						run_number: 4,
						head_repository: { full_name: mixedCaseRepo, fork: false }
					}
				},
				env: {
					GITHUB_REPOSITORY: mixedCaseRepo,
					GITHUB_API_URL: baseUrl,
					GHCR_URL: baseUrl
				}
			});

			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.outputFile, 'ready=true\n');
			assert.match(result.stdout, /ready=true/);
			assert.equal(requests.length, 3);
			assert.equal(
				requests[0]?.url,
				`/repos/Sgerner/Flavorithm/actions/runs?head_sha=${defaultSha}&event=push&branch=main&per_page=100&page=1`
			);
			assert.equal(requests[2]?.url, `/v2/sgerner/flavorithm/manifests/sha-${defaultSha}`);
			assert.match(requests[2]?.accept ?? '', /application\/vnd\.oci\.image\.manifest\.v1\+json/);
		}
	);
});

test('publish gate outputs ready=false and exits 0 when sibling workflow is pending or missing', async () => {
	await withMockApis(
		{
			pages: [[makeRun('CI'), makeRun('Security', { status: 'in_progress', conclusion: null })]]
		},
		async ({ baseUrl, requests }) => {
			const pending = await runGate({
				event: buildEvent(),
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.equal(pending.status, 0, pending.stderr);
			assert.equal(pending.outputFile, 'ready=false\n');
			assert.match(pending.stdout, /Security push run #1 is in_progress/);
			assert.equal(requests.length, 1, 'GHCR must not be queried while sibling run is pending');
		}
	);

	await withMockApis({ pages: [[makeRun('CI')]] }, async ({ baseUrl, requests }) => {
		const missing = await runGate({
			event: buildEvent(),
			env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
		});
		assert.equal(missing.status, 0, missing.stderr);
		assert.equal(missing.outputFile, 'ready=false\n');
		assert.equal(requests.length, 1);
	});
});

test('publish gate outputs ready=false and exits 0 when either workflow failed', async () => {
	await withMockApis(
		{
			pages: [[makeRun('CI'), makeRun('Security', { conclusion: 'failure' })]]
		},
		async ({ baseUrl, requests }) => {
			const siblingFailed = await runGate({
				event: buildEvent(),
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.equal(siblingFailed.status, 0, siblingFailed.stderr);
			assert.equal(siblingFailed.outputFile, 'ready=false\n');
			assert.match(siblingFailed.stdout, /Security push run #1 concluded with failure/);
			assert.equal(requests.length, 1);
		}
	);

	await withMockApis({ pages: [] }, async ({ baseUrl, requests }) => {
		const triggeringFailed = await runGate({
			event: buildEvent({ conclusion: 'failure' }),
			env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
		});
		assert.equal(triggeringFailed.status, 0, triggeringFailed.stderr);
		assert.equal(triggeringFailed.outputFile, 'ready=false\n');
		assert.equal(requests.length, 0);
	});
});

test('publish gate selects highest run_number and strips @ref suffixes across paginated runs', async () => {
	await withMockApis(
		{
			pages: [
				[
					makeRun('CI', {
						path: '.github/workflows/ci.yml@refs/heads/main',
						run_number: 10,
						conclusion: 'failure'
					}),
					makeRun('Security', {
						path: '.github/workflows/security.yml@refs/heads/main',
						run_number: 7,
						conclusion: 'failure'
					})
				],
				[
					makeRun('CI', {
						path: '.github/workflows/ci.yml@0123456789abcdef0123456789abcdef01234567',
						run_number: 11,
						conclusion: 'success'
					}),
					makeRun('Security', {
						path: '.github/workflows/security.yml@main',
						run_number: 8,
						conclusion: 'success'
					})
				]
			],
			ghcrManifestStatus: 404
		},
		async ({ baseUrl, requests }) => {
			const recovered = await runGate({
				event: buildEvent({ run_number: 11 }),
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.equal(recovered.status, 0, recovered.stderr);
			assert.equal(recovered.outputFile, 'ready=true\n');
			assert.equal(requests.length, 4, 'two paginated GitHub pages plus GHCR token and manifest');
		}
	);

	await withMockApis(
		{
			pages: [
				[
					makeRun('CI', {
						path: '.github/workflows/ci.yml@refs/heads/main',
						run_number: 11,
						conclusion: 'success'
					}),
					makeRun('Security', {
						path: '.github/workflows/security.yml@refs/heads/main',
						run_number: 8,
						conclusion: 'success'
					})
				],
				[
					makeRun('Security', {
						path: '.github/workflows/security.yml@refs/heads/main',
						run_number: 9,
						conclusion: 'failure'
					})
				]
			]
		},
		async ({ baseUrl }) => {
			const regressed = await runGate({
				event: buildEvent({ run_number: 11 }),
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.equal(regressed.status, 0, regressed.stderr);
			assert.equal(regressed.outputFile, 'ready=false\n');
			assert.match(regressed.stdout, /Security push run #9 concluded with failure/);
		}
	);
});

test('publish gate skips tags already present in ghcr.io', async () => {
	await withMockApis(
		{
			pages: [[makeRun('CI', { run_number: 5 }), makeRun('Security', { run_number: 5 })]],
			ghcrManifestStatus: 200
		},
		async ({ baseUrl, requests }) => {
			const duplicate = await runGate({
				event: buildEvent({ run_number: 5 }),
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.equal(duplicate.status, 0, duplicate.stderr);
			assert.equal(duplicate.outputFile, 'ready=false\n');
			assert.match(
				duplicate.stdout,
				new RegExp(`tag sha-${defaultSha} already exists in ghcr\\.io`)
			);
			assert.equal(requests.length, 3);
		}
	);
});

test('publish gate rejects fork, non-push, and non-main workflow_run events without API calls', async () => {
	await withMockApis({ pages: [] }, async ({ baseUrl, requests }) => {
		const cases = [
			buildEvent({
				event: 'pull_request',
				head_repository: { full_name: 'attacker/flavorithm', fork: true }
			}),
			buildEvent({
				head_repository: { full_name: defaultRepository, fork: true }
			}),
			buildEvent({
				head_repository: { full_name: 'other-owner/flavorithm', fork: false }
			}),
			buildEvent({ event: 'schedule' }),
			buildEvent({ event: 'workflow_dispatch' }),
			buildEvent({ head_branch: 'feature/branch' })
		];

		for (const event of cases) {
			const result = await runGate({
				event,
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.outputFile, 'ready=false\n');
		}
		assert.equal(requests.length, 0);
	});
});

test('publish gate exits non-zero on GitHub or GHCR API errors without exposing tokens', async () => {
	await withMockApis({ githubStatus: 502 }, async ({ baseUrl }) => {
		const githubError = await runGate({
			event: buildEvent(),
			env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
		});
		assert.notEqual(githubError.status, 0);
		assert.equal(githubError.outputFile, '');
		assert.match(githubError.stderr, /GitHub workflow runs request failed \(502\)/);
		assert.doesNotMatch(githubError.stderr, new RegExp(testGithubToken));
	});

	await withMockApis(
		{
			pages: [[makeRun('CI'), makeRun('Security')]],
			ghcrTokenStatus: 401
		},
		async ({ baseUrl }) => {
			const tokenError = await runGate({
				event: buildEvent(),
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.notEqual(tokenError.status, 0);
			assert.equal(tokenError.outputFile, '');
			assert.match(tokenError.stderr, /GHCR token login failed \(401\)/);
			assert.doesNotMatch(tokenError.stderr, new RegExp(testGithubToken));
		}
	);

	await withMockApis(
		{
			pages: [[makeRun('CI'), makeRun('Security')]],
			ghcrManifestStatus: 500
		},
		async ({ baseUrl }) => {
			const manifestError = await runGate({
				event: buildEvent(),
				env: { GITHUB_API_URL: baseUrl, GHCR_URL: baseUrl }
			});
			assert.notEqual(manifestError.status, 0);
			assert.equal(manifestError.outputFile, '');
			assert.match(manifestError.stderr, /GHCR manifest inspection failed \(500\)/);
			assert.doesNotMatch(manifestError.stderr, new RegExp(testRegistryToken));
		}
	);

	const missingToken = await runGate({
		event: buildEvent(),
		env: { GITHUB_TOKEN: '' }
	});
	assert.notEqual(missingToken.status, 0);
	assert.match(missingToken.stderr, /GITHUB_TOKEN is required/);
});

test('container workflow triggers on CI and Security with non-cancelling per-SHA concurrency and isolated write permissions', () => {
	const workflow = readFileSync(containerWorkflowPath, 'utf8');
	assert.match(workflow, /workflows:\s*\[CI,\s*Security\]/);
	assert.match(
		workflow,
		/group:\s*publish-container-\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/
	);
	assert.match(workflow, /cancel-in-progress:\s*false/);
	assert.match(workflow, /gate:\s[\s\S]*?actions:\s*read[\s\S]*?packages:\s*read/);
	assert.equal((workflow.match(/packages:\s*write/g) ?? []).length, 1);
	assert.match(
		workflow,
		/publish:\s[\s\S]*?needs:\s*gate[\s\S]*?needs\.gate\.outputs\.ready == 'true'/
	);
});
