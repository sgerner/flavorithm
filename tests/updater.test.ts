import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const updaterScriptPath = resolve('deploy/skynet/update.sh');
const realComposePath = resolve('compose.yml');
const realOverridePath = resolve('deploy/skynet/compose.override.yml');

interface CheckRunFixture {
	name: string;
	status: string;
	conclusion: string | null;
	app?: { slug?: string } | null;
	head_sha?: string;
}

interface RecordedRequest {
	method: string;
	url: string;
	authorization: string | undefined;
}

interface Harness {
	rootDir: string;
	bareRepoDir: string;
	workRepoDir: string;
	appDir: string;
	stateDir: string;
	runtimeScriptPath: string;
	binDir: string;
	dockerStateFile: string;
	dockerLogFile: string;
	requests: RecordedRequest[];
	setCheckRuns: (sha: string, runs: CheckRunFixture[], statusCode?: number) => void;
	commitAndPush: (files: Record<string, string>, message: string) => string;
	readDockerState: () => DockerSimState;
	writeDockerState: (patch: Partial<DockerSimState>) => void;
	readDockerLog: () => string[];
	clearDockerLog: () => void;
	runUpdater: (options?: {
		env?: Record<string, string | undefined>;
		useIsolatedTools?: boolean;
	}) => Promise<{ code: number | null; stdout: string; stderr: string }>;
	cleanup: () => Promise<void>;
}

interface DockerSimState {
	containerImage: string;
	containerHealth: string;
	tags: Record<string, string>;
	imageHealthMap: Record<string, string>;
	nextBuildImage: string;
	failBuild: boolean;
	failUpCount: number;
	failRollbackHealthCount: number;
}

function git(cwd: string, args: string[]) {
	const res = spawnSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test Author',
			GIT_AUTHOR_EMAIL: 'author@flavorithm.test',
			GIT_COMMITTER_NAME: 'Test Author',
			GIT_COMMITTER_EMAIL: 'author@flavorithm.test'
		}
	});
	assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
	return res.stdout.trim();
}

function findCommand(name: string): string {
	const res = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
	assert.equal(res.status, 0, `Missing required host tool: ${name}`);
	return res.stdout.trim();
}

async function createHarness(): Promise<Harness> {
	const rootDir = mkdtempSync(join(tmpdir(), 'flavorithm-updater-test-'));
	const bareRepoDir = join(rootDir, 'origin.git');
	const workRepoDir = join(rootDir, 'work');
	const appDir = join(rootDir, 'app');
	const stateDir = join(rootDir, 'state');
	const runtimeScriptPath = join(rootDir, 'tmp', 'flavorithm-update.sh');
	const binDir = join(rootDir, 'bin');
	const dockerStateFile = join(rootDir, 'docker-state.json');
	const dockerLogFile = join(rootDir, 'docker-commands.log');

	mkdirSync(bareRepoDir, { recursive: true });
	mkdirSync(workRepoDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });

	git(bareRepoDir, ['init', '--bare', '--initial-branch=main']);
	git(workRepoDir, ['init', '--initial-branch=main']);

	mkdirSync(join(workRepoDir, 'deploy', 'skynet'), { recursive: true });
	copyFileSync(realComposePath, join(workRepoDir, 'compose.yml'));
	copyFileSync(realOverridePath, join(workRepoDir, 'deploy', 'skynet', 'compose.override.yml'));
	copyFileSync(updaterScriptPath, join(workRepoDir, 'deploy', 'skynet', 'update.sh'));
	chmodSync(join(workRepoDir, 'deploy', 'skynet', 'update.sh'), 0o755);
	writeFileSync(join(workRepoDir, 'version.txt'), 'v1\n');

	git(workRepoDir, ['add', '.']);
	git(workRepoDir, ['commit', '-m', 'Initial healthy release']);
	const initialSha = git(workRepoDir, ['rev-parse', 'HEAD']);
	git(workRepoDir, ['push', bareRepoDir, 'HEAD:refs/heads/main']);

	git(rootDir, ['clone', bareRepoDir, appDir]);
	writeFileSync(join(appDir, '.env'), 'ORIGIN=https://eat.flavorithm.test\n');

	const initialImage = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
	writeFileSync(join(stateDir, 'deployed-sha'), `${initialSha}\n`);
	writeFileSync(join(stateDir, 'deployed-image'), `${initialImage}\n`);

	const initialDockerState: DockerSimState = {
		containerImage: initialImage,
		containerHealth: 'healthy',
		tags: {
			'flavorithm:local': initialImage,
			'flavorithm:rollback': initialImage
		},
		imageHealthMap: {
			[initialImage]: 'healthy'
		},
		nextBuildImage: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
		failBuild: false,
		failUpCount: 0,
		failRollbackHealthCount: 0
	};
	writeFileSync(dockerStateFile, JSON.stringify(initialDockerState, null, 2));
	writeFileSync(dockerLogFile, '');

	const mockDockerMjs = join(binDir, 'mock-docker.mjs');
	writeFileSync(
		mockDockerMjs,
		`import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const statePath = process.env.MOCK_DOCKER_STATE_FILE;
const logPath = process.env.MOCK_DOCKER_LOG_FILE;
const appDir = process.env.FLAVORITHM_UPDATE_APP_DIR;
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, 'utf8'));

let appHead = '';
try {
	const headContent = readFileSync(join(appDir, '.git', 'HEAD'), 'utf8').trim();
	appHead = headContent.startsWith('ref: ')
		? readFileSync(join(appDir, '.git', headContent.slice(5)), 'utf8').trim()
		: headContent;
} catch {}

appendFileSync(logPath, JSON.stringify({ args, appHead }) + '\\n');

function saveState() {
	writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function validateComposeFiles(composePaths) {
	if (composePaths.length === 0) return false;
	for (const file of composePaths) {
		if (!existsSync(file)) return false;
		const content = readFileSync(file, 'utf8');
		if (
			content.includes('INVALID_COMPOSE_SYNTAX') ||
			!content.includes('services:') ||
			content.includes(':\\n\\t')
		) {
			return false;
		}
	}
	const envPath = join(dirname(composePaths[0]), '.env');
	return existsSync(envPath);
}

if (args[0] === 'inspect') {
	const fmtIdx = args.indexOf('--format');
	const fmt = fmtIdx >= 0 ? args[fmtIdx + 1] : '';
	if (fmt.includes('.Image')) {
		process.stdout.write(state.containerImage + '\\n');
		process.exit(0);
	}
	if (fmt.includes('.State.Health')) {
		if (
			state.containerImage === state.tags['flavorithm:rollback'] &&
			state.failRollbackHealthCount > 0
		) {
			state.failRollbackHealthCount -= 1;
			saveState();
			process.stdout.write('unhealthy\\n');
			process.exit(0);
		}
		process.stdout.write(state.containerHealth + '\\n');
		process.exit(0);
	}
	process.exit(1);
}

if (args[0] === 'tag') {
	const [, src, dst] = args;
	const resolved = state.tags[src] || src;
	if (!resolved || (!resolved.startsWith('sha256:') && !state.tags[src])) {
		process.stderr.write('No such image: ' + src + '\\n');
		process.exit(1);
	}
	state.tags[dst] = resolved;
	saveState();
	process.exit(0);
}

if (args[0] === 'compose') {
	const composeFiles = [];
	for (let i = 1; i < args.length; i += 1) {
		if (args[i] === '-f' && args[i + 1]) {
			composeFiles.push(args[i + 1]);
			i += 1;
		}
	}
	if (!validateComposeFiles(composeFiles)) {
		process.stderr.write('invalid compose configuration\\n');
		process.exit(1);
	}
	if (args.includes('config')) {
		process.exit(0);
	}
	if (args.includes('build')) {
		if (state.failBuild) {
			process.stderr.write('docker build failed\\n');
			process.exit(1);
		}
		state.tags['flavorithm:local'] = state.nextBuildImage;
		saveState();
		process.exit(0);
	}
	if (args.includes('up')) {
		if (state.failUpCount > 0) {
			state.failUpCount -= 1;
			saveState();
			process.stderr.write('docker compose up failed\\n');
			process.exit(1);
		}
		const localImage = state.tags['flavorithm:local'];
		if (!localImage) {
			process.stderr.write('missing flavorithm:local\\n');
			process.exit(1);
		}
		state.containerImage = localImage;
		state.containerHealth = state.imageHealthMap[localImage] ?? 'healthy';
		saveState();
		process.exit(0);
	}
}

process.stderr.write('Unsupported mock docker command: ' + args.join(' ') + '\\n');
process.exit(1);
`
	);

	const mockDockerSh = join(binDir, 'docker');
	writeFileSync(mockDockerSh, `#!/bin/sh\nexec "${process.execPath}" "${mockDockerMjs}" "$@"\n`);
	chmodSync(mockDockerSh, 0o755);

	const requests: RecordedRequest[] = [];
	const checkResponses = new Map<string, { statusCode: number; runs: CheckRunFixture[] }>();

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? '';
		requests.push({
			method: req.method ?? 'GET',
			url,
			authorization:
				typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
		});

		const match = url.match(
			/^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-fA-F]{40})\/check-runs\?check_name=verify&filter=latest$/
		);
		if (!match) {
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ message: 'Not Found' }));
			return;
		}
		const sha = match[3].toLowerCase();
		const configured = checkResponses.get(sha);
		if (!configured) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ total_count: 0, check_runs: [] }));
			return;
		}
		res.writeHead(configured.statusCode, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				total_count: configured.runs.length,
				check_runs: configured.runs
			})
		);
	});

	await new Promise<void>((resolveListen) => {
		server.listen(0, '127.0.0.1', () => resolveListen());
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const apiBaseUrl = `http://127.0.0.1:${address.port}`;

	function setCheckRuns(sha: string, runs: CheckRunFixture[], statusCode = 200) {
		checkResponses.set(sha.toLowerCase(), { statusCode, runs });
	}

	function commitAndPush(files: Record<string, string>, message: string): string {
		for (const [relPath, content] of Object.entries(files)) {
			const fullPath = join(workRepoDir, relPath);
			mkdirSync(dirname(fullPath), { recursive: true });
			writeFileSync(fullPath, content);
		}
		git(workRepoDir, ['add', '.']);
		git(workRepoDir, ['commit', '-m', message]);
		const sha = git(workRepoDir, ['rev-parse', 'HEAD']);
		git(workRepoDir, ['push', bareRepoDir, 'HEAD:refs/heads/main']);
		return sha;
	}

	function readDockerState(): DockerSimState {
		return JSON.parse(readFileSync(dockerStateFile, 'utf8')) as DockerSimState;
	}

	function writeDockerState(patch: Partial<DockerSimState>) {
		const next = { ...readDockerState(), ...patch };
		writeFileSync(dockerStateFile, JSON.stringify(next, null, 2));
	}

	function readDockerLog(): string[] {
		const raw = readFileSync(dockerLogFile, 'utf8').trim();
		if (!raw) return [];
		return raw.split('\n');
	}

	function clearDockerLog() {
		writeFileSync(dockerLogFile, '');
	}

	async function runUpdater(options?: {
		env?: Record<string, string | undefined>;
		useIsolatedTools?: boolean;
	}) {
		let pathEnv = `${binDir}:${process.env.PATH ?? ''}`;
		let isolatedDir: string | undefined;
		if (options?.useIsolatedTools) {
			isolatedDir = mkdtempSync(join(rootDir, 'isolated-bin-'));
			for (const cmd of [
				'sh',
				'mkdir',
				'dirname',
				'cp',
				'ln',
				'chmod',
				'mv',
				'rm',
				'cat',
				'tr',
				'awk',
				'cmp',
				'sleep',
				'timeout',
				'base64',
				'git',
				'curl'
			]) {
				symlinkSync(findCommand(cmd), join(isolatedDir, cmd));
			}
			symlinkSync(mockDockerSh, join(isolatedDir, 'docker'));
			const realJq = findCommand('jq');
			const mockApk = join(isolatedDir, 'apk');
			writeFileSync(
				mockApk,
				`#!/bin/sh
printf '%s\\n' "$*" >> "${join(rootDir, 'apk.log')}"
ln -sf "${realJq}" "${join(isolatedDir, 'jq')}"
`
			);
			chmodSync(mockApk, 0o755);
			pathEnv = isolatedDir;
		}

		const repoUrl =
			options?.env && 'FLAVORITHM_UPDATE_REPO_URL' in options.env
				? (options.env.FLAVORITHM_UPDATE_REPO_URL ?? '')
				: 'https://github.com/sgerner/flavorithm.git';

		const mergedEnv: NodeJS.ProcessEnv = {
			...process.env,
			PATH: pathEnv,
			MOCK_DOCKER_STATE_FILE: dockerStateFile,
			MOCK_DOCKER_LOG_FILE: dockerLogFile,
			FLAVORITHM_UPDATE_INTERVAL_SECONDS: '0',
			FLAVORITHM_UPDATE_COMMAND_TIMEOUT_SECONDS: '15',
			FLAVORITHM_UPDATE_BRANCH: 'main',
			FLAVORITHM_UPDATE_REPO_URL: repoUrl,
			FLAVORITHM_GITHUB_API_URL: apiBaseUrl,
			FLAVORITHM_UPDATE_APP_DIR: appDir,
			FLAVORITHM_UPDATE_STATE_DIR: stateDir,
			FLAVORITHM_UPDATER_RUNTIME_SCRIPT: runtimeScriptPath,
			FLAVORITHM_HEALTH_MAX_ATTEMPTS: '2',
			FLAVORITHM_HEALTH_INTERVAL_SECONDS: '0',
			FLAVORITHM_UPDATE_MAX_POLLS: '1',
			GIT_CONFIG_COUNT: '2',
			GIT_CONFIG_KEY_0: `url.${bareRepoDir}.insteadOf`,
			GIT_CONFIG_VALUE_0: 'https://github.com/sgerner/flavorithm.git',
			GIT_CONFIG_KEY_1: `url.${bareRepoDir}.insteadOf`,
			GIT_CONFIG_VALUE_1: 'git@github.com:sgerner/flavorithm.git',
			...options?.env
		};

		return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
			const child = spawn('/bin/sh', [join(appDir, 'deploy', 'skynet', 'update.sh')], {
				cwd: appDir,
				env: mergedEnv
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});
			child.on('close', (code) => {
				if (isolatedDir) {
					rmSync(isolatedDir, { recursive: true, force: true });
				}
				resolveRun({ code, stdout, stderr });
			});
		});
	}

	async function cleanup() {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		rmSync(rootDir, { recursive: true, force: true });
	}

	return {
		rootDir,
		bareRepoDir,
		workRepoDir,
		appDir,
		stateDir,
		runtimeScriptPath,
		binDir,
		dockerStateFile,
		dockerLogFile,
		requests,
		setCheckRuns,
		commitAndPush,
		readDockerState,
		writeDockerState,
		readDockerLog,
		clearDockerLog,
		runUpdater,
		cleanup
	};
}

test('copies updater to /tmp, installs missing apk tools, and skips GitHub API when SHA matches deployed or failed state', async () => {
	const h = await createHarness();
	try {
		const upToDate = await h.runUpdater({ useIsolatedTools: true });
		assert.equal(upToDate.code, 0, upToDate.stderr);
		assert.ok(existsSync(h.runtimeScriptPath), 'Expected updater copy in /tmp');
		assert.equal(
			readFileSync(join(h.rootDir, 'apk.log'), 'utf8').trim(),
			'add --no-cache git curl jq'
		);
		assert.match(upToDate.stdout, /No update detected/);
		assert.equal(
			h.requests.length,
			0,
			'Should not call GitHub API when remote_sha == deployed_sha'
		);

		const failedSha = h.commitAndPush({ 'version.txt': 'broken\n' }, 'Previously failed commit');
		writeFileSync(join(h.stateDir, 'failed-sha'), `${failedSha}\n`);
		const skippedFailed = await h.runUpdater();
		assert.equal(skippedFailed.code, 0, skippedFailed.stderr);
		assert.match(skippedFailed.stdout, /Skipping previously failed commit/);
		assert.equal(h.requests.length, 0, 'Should not call GitHub API when remote_sha == failed-sha');

		// Existing deployment upgrade: seeds missing deployed-image only when container is healthy
		rmSync(join(h.stateDir, 'deployed-image'), { force: true });
		rmSync(join(h.stateDir, 'failed-sha'), { force: true });
		writeFileSync(join(h.stateDir, 'deployed-sha'), `${failedSha}\n`);
		git(h.appDir, ['fetch', '--no-tags', h.bareRepoDir, failedSha]);
		git(h.appDir, ['checkout', '--force', failedSha]);
		h.writeDockerState({ containerHealth: 'unhealthy' });
		await h.runUpdater();
		assert.equal(
			existsSync(join(h.stateDir, 'deployed-image')),
			false,
			'Must never seed deployed-image from an unhealthy container'
		);

		h.writeDockerState({ containerHealth: 'healthy' });
		await h.runUpdater();
		assert.equal(
			readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim(),
			h.readDockerState().containerImage
		);
	} finally {
		await h.cleanup();
	}
});

test('validates GitHub repo URLs and 40-char SHAs and supports optional FLAVORITHM_GITHUB_TOKEN', async () => {
	const h = await createHarness();
	try {
		const nextSha = h.commitAndPush({ 'version.txt': 'v2\n' }, 'Candidate commit');

		for (const badUrl of [
			'https://gitlab.com/sgerner/flavorithm.git',
			'https://github.com/sgerner/flavorithm/extra',
			'https://github.com/sgerner/flavorithm?check_name=none',
			'https://github.com/sgerner/..',
			'https://github.com/-bad/flavorithm.git'
		]) {
			const res = await h.runUpdater({ env: { FLAVORITHM_UPDATE_REPO_URL: badUrl } });
			assert.equal(res.code, 0);
			assert.match(res.stdout, /Invalid GitHub repository URL/);
		}
		assert.equal(h.requests.length, 0);

		// Simulate malformed non-40-hex output from git ls-remote via branch with no ref
		const missingBranch = await h.runUpdater({
			env: { FLAVORITHM_UPDATE_BRANCH: 'nonexistent-branch' }
		});
		assert.equal(missingBranch.code, 0);
		assert.match(missingBranch.stdout, /Could not resolve a valid 40-character SHA/);
		assert.equal(h.requests.length, 0);

		// Verify SSH repo URL parsing + optional FLAVORITHM_GITHUB_TOKEN header forwarding
		h.setCheckRuns(nextSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' },
				head_sha: nextSha
			}
		]);
		const sshDeploy = await h.runUpdater({
			env: {
				FLAVORITHM_UPDATE_REPO_URL: 'git@github.com:sgerner/flavorithm.git',
				FLAVORITHM_GITHUB_TOKEN: 'ghp_secretTestToken123'
			}
		});
		assert.equal(sshDeploy.code, 0, sshDeploy.stderr);
		assert.match(sshDeploy.stdout, /Flavorithm updated successfully/);
		assert.doesNotMatch(sshDeploy.stdout + sshDeploy.stderr, /ghp_secretTestToken123/);
		assert.equal(h.requests.length, 1);
		assert.equal(
			h.requests[0].url,
			`/repos/sgerner/flavorithm/commits/${nextSha}/check-runs?check_name=verify&filter=latest`
		);
		assert.equal(h.requests[0].authorization, 'Bearer ghp_secretTestToken123');
	} finally {
		await h.cleanup();
	}
});

test('gates deployment on github-actions verify check-run success and deploys once verified', async () => {
	const h = await createHarness();
	try {
		const initialSha = readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim();
		const nextImage = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
		h.writeDockerState({
			nextBuildImage: nextImage,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[nextImage]: 'healthy'
			}
		});

		const candidateSha = h.commitAndPush({ 'version.txt': 'v2-gated\n' }, 'Gated release');

		const blockedFixtures: CheckRunFixture[][] = [
			[], // Not queued yet
			[
				{
					name: 'verify',
					status: 'in_progress',
					conclusion: null,
					app: { slug: 'github-actions' }
				}
			],
			[
				{
					name: 'verify',
					status: 'completed',
					conclusion: 'failure',
					app: { slug: 'github-actions' }
				}
			],
			[
				{
					name: 'verify',
					status: 'completed',
					conclusion: 'success',
					app: { slug: 'third-party-check' }
				}
			],
			[
				{
					name: 'verify',
					status: 'completed',
					conclusion: 'success',
					app: { slug: 'github-actions' }
				},
				{
					name: 'verify',
					status: 'completed',
					conclusion: 'cancelled',
					app: { slug: 'github-actions' }
				}
			]
		];

		for (const runs of blockedFixtures) {
			h.setCheckRuns(candidateSha, runs);
			const skipped = await h.runUpdater();
			assert.equal(skipped.code, 0, skipped.stderr);
			assert.match(skipped.stdout, /verify check-run has not completed with success/);
			assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), initialSha);
			assert.equal(readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim(), initialSha);
			assert.equal(existsSync(join(h.stateDir, 'failed-sha')), false);
		}

		// Once GitHub Actions verify finishes with success, the next poll deploys it
		h.setCheckRuns(candidateSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' },
				head_sha: candidateSha
			}
		]);
		const deployed = await h.runUpdater();
		assert.equal(deployed.code, 0, deployed.stderr);
		assert.match(deployed.stdout, /Flavorithm updated successfully/);
		assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), candidateSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim(), candidateSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim(), nextImage);
		assert.equal(h.readDockerState().tags['flavorithm:rollback'], nextImage);
		assert.equal(h.readDockerState().tags['flavorithm:local'], nextImage);
	} finally {
		await h.cleanup();
	}
});

test('resets /app to deployed_sha before rollback when compose.override.yml is invalid', async () => {
	const h = await createHarness();
	try {
		const initialSha = readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim();
		const initialImage = readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim();

		const brokenComposeSha = h.commitAndPush(
			{
				'deploy/skynet/compose.override.yml': 'INVALID_COMPOSE_SYNTAX: [\n'
			},
			'Break compose override'
		);
		h.setCheckRuns(brokenComposeSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);
		h.clearDockerLog();

		const res = await h.runUpdater();
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /Compose validation, build, or health check failed/);
		assert.match(res.stdout, /Rollback to .* succeeded/);

		assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), initialSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim(), initialSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim(), initialImage);
		assert.equal(readFileSync(join(h.stateDir, 'failed-sha'), 'utf8').trim(), brokenComposeSha);

		const entries = h
			.readDockerLog()
			.map((line) => JSON.parse(line) as { args: string[]; appHead: string });
		const failedConfigIdx = entries.findIndex(
			(e) => e.args[0] === 'compose' && e.args.includes('config') && e.appHead === brokenComposeSha
		);
		const rollbackUpIdx = entries.findIndex(
			(e) => e.args[0] === 'compose' && e.args.includes('up')
		);
		assert.ok(failedConfigIdx >= 0, 'Expected compose config validation on candidate SHA');
		assert.ok(rollbackUpIdx > failedConfigIdx, 'Expected compose up during rollback');
		assert.equal(
			entries[rollbackUpIdx].appHead,
			initialSha,
			'Expected /app to be reset to deployed_sha BEFORE rollback compose up'
		);
		assert.equal(
			entries.some((e) => e.args[0] === 'compose' && e.args.includes('build')),
			false,
			'Should not run docker compose build when compose config fails'
		);
	} finally {
		await h.cleanup();
	}
});

test('rolls back container image and checkout when new container fails health check', async () => {
	const h = await createHarness();
	try {
		const initialSha = readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim();
		const initialImage = readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim();
		const unhealthyImage =
			'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

		h.writeDockerState({
			nextBuildImage: unhealthyImage,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[unhealthyImage]: 'unhealthy'
			}
		});

		const brokenAppSha = h.commitAndPush({ 'version.txt': 'unhealthy-build\n' }, 'Unhealthy app');
		h.setCheckRuns(brokenAppSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const res = await h.runUpdater();
		assert.equal(res.code, 0, res.stderr);
		assert.match(res.stdout, /Flavorithm did not become healthy after the update/);
		assert.match(res.stdout, /Rollback to .* succeeded/);

		assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), initialSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim(), initialSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim(), initialImage);
		assert.equal(readFileSync(join(h.stateDir, 'failed-sha'), 'utf8').trim(), brokenAppSha);

		const finalDocker = h.readDockerState();
		assert.equal(finalDocker.containerImage, initialImage);
		assert.equal(finalDocker.containerHealth, 'healthy');
		assert.equal(finalDocker.tags['flavorithm:local'], initialImage);
		assert.equal(finalDocker.tags['flavorithm:rollback'], initialImage);
	} finally {
		await h.cleanup();
	}
});

test('preserves deployed-image when Poll 1 rollback fails and retries recovery on Poll 2 without rebuilding', async () => {
	const h = await createHarness();
	try {
		const initialSha = readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim();
		const initialImage = readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim();
		const brokenImage = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

		h.writeDockerState({
			nextBuildImage: brokenImage,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[brokenImage]: 'unhealthy'
			},
			// Rollback health check fails across both attempts on Poll 1 (health_max_attempts=2)
			failRollbackHealthCount: 2
		});

		const brokenSha = h.commitAndPush({ 'version.txt': 'rollback-retry\n' }, 'Broken release');
		h.setCheckRuns(brokenSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		// Poll 1: deployment fails AND rollback health check fails
		const poll1 = await h.runUpdater();
		assert.equal(poll1.code, 0, poll1.stderr);
		assert.match(poll1.stdout, /Rollback failed; retrying recovery/);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim(), initialImage);
		assert.equal(h.readDockerState().tags['flavorithm:rollback'], initialImage);
		assert.equal(
			existsSync(join(h.stateDir, 'failed-sha')),
			false,
			'failed-sha must not be recorded before verified rollback'
		);
		assert.equal(readFileSync(join(h.stateDir, 'rollback-pending'), 'utf8').trim(), brokenSha);

		// Poll 2: retries restoring deployed_sha without rebuilding or calling GitHub API
		const requestsBeforePoll2 = h.requests.length;
		h.clearDockerLog();
		const poll2 = await h.runUpdater();
		assert.equal(poll2.code, 0, poll2.stderr);
		assert.match(poll2.stdout, /Retrying pending rollback/);
		assert.match(poll2.stdout, /Rollback to .* succeeded/);

		assert.equal(
			h.requests.length,
			requestsBeforePoll2,
			'Poll 2 recovery must not call GitHub API'
		);
		const poll2Entries = h
			.readDockerLog()
			.map((line) => JSON.parse(line) as { args: string[]; appHead: string });
		assert.equal(
			poll2Entries.some((e) => e.args[0] === 'compose' && e.args.includes('build')),
			false,
			'Poll 2 must not rebuild broken commit over flavorithm:local'
		);

		assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), initialSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim(), initialSha);
		assert.equal(readFileSync(join(h.stateDir, 'deployed-image'), 'utf8').trim(), initialImage);
		assert.equal(readFileSync(join(h.stateDir, 'failed-sha'), 'utf8').trim(), brokenSha);
		assert.equal(existsSync(join(h.stateDir, 'rollback-pending')), false);
		assert.equal(h.readDockerState().tags['flavorithm:local'], initialImage);
		assert.equal(h.readDockerState().containerImage, initialImage);
		assert.equal(h.readDockerState().containerHealth, 'healthy');
	} finally {
		await h.cleanup();
	}
});

test('isolates active /tmp script from corrupted update.sh during rollback and re-executes healthy script updates', async () => {
	const h = await createHarness();
	try {
		const initialSha = readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim();

		// Part A: Commit corrupts deploy/skynet/update.sh AND breaks compose.override.yml
		const corruptUpdaterSha = h.commitAndPush(
			{
				'deploy/skynet/update.sh': '#!/bin/sh\nfi )) syntax error in repo copy\n',
				'deploy/skynet/compose.override.yml': 'INVALID_COMPOSE_SYNTAX: [\n'
			},
			'Corrupt update.sh with broken compose'
		);
		h.setCheckRuns(corruptUpdaterSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const rollbackRes = await h.runUpdater();
		assert.equal(rollbackRes.code, 0, rollbackRes.stderr);
		assert.match(rollbackRes.stdout, /Rollback to .* succeeded/);
		assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), initialSha);

		// Part B: Healthy commit updates deploy/skynet/update.sh itself
		git(h.workRepoDir, ['reset', '--hard', initialSha]);
		const updatedScript = readFileSync(updaterScriptPath, 'utf8').replace(
			'completed_polls=0',
			'log "re-executed-updated-script-v2"\ncompleted_polls=0'
		);
		writeFileSync(join(h.workRepoDir, 'deploy', 'skynet', 'update.sh'), updatedScript);
		chmodSync(join(h.workRepoDir, 'deploy', 'skynet', 'update.sh'), 0o755);
		git(h.workRepoDir, ['add', 'deploy/skynet/update.sh']);
		git(h.workRepoDir, ['commit', '-m', 'Healthy updater self-update']);
		const selfUpdateSha = git(h.workRepoDir, ['rev-parse', 'HEAD']);
		git(h.workRepoDir, ['push', '--force', h.bareRepoDir, 'HEAD:refs/heads/main']);

		const nextImage = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
		h.writeDockerState({
			nextBuildImage: nextImage,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[nextImage]: 'healthy'
			}
		});
		h.setCheckRuns(selfUpdateSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const selfUpdateRes = await h.runUpdater();
		assert.equal(selfUpdateRes.code, 0, selfUpdateRes.stderr);
		assert.match(selfUpdateRes.stdout, /Flavorithm updated successfully/);
		assert.match(selfUpdateRes.stdout, /Updater script changed; re-executing/);
		assert.match(selfUpdateRes.stdout, /re-executed-updated-script-v2/);
		assert.match(selfUpdateRes.stdout, new RegExp(`No update detected \\(${selfUpdateSha}\\)`));
		assert.equal(readFileSync(join(h.stateDir, 'deployed-sha'), 'utf8').trim(), selfUpdateSha);
		assert.equal(readFileSync(h.runtimeScriptPath, 'utf8'), updatedScript);
	} finally {
		await h.cleanup();
	}
});
