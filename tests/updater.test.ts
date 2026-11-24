import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
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
	details_url?: string | null;
	html_url?: string | null;
	workflow_path?: string;
	workflow_status?: string;
	workflow_conclusion?: string | null;
	workflow_status_code?: number;
}

interface RecordedRequest {
	method: string;
	url: string;
	authorization: string | undefined;
}

interface DeployedState {
	sha: string;
	image: string;
}

interface Harness {
	rootDir: string;
	bareRepoDir: string;
	workRepoDir: string;
	appDir: string;
	stateDir: string;
	tmpRuntimeBaseDir: string;
	runtimeScriptPath: string;
	binDir: string;
	dockerStateFile: string;
	dockerLogFile: string;
	requests: RecordedRequest[];
	setCheckRuns: (sha: string, runs: CheckRunFixture[], statusCode?: number) => void;
	commitAndPush: (files: Record<string, string>, message: string) => string;
	readDeployedState: () => DeployedState;
	writeDeployedState: (sha: string, image: string) => void;
	readDockerState: () => DockerSimState;
	writeDockerState: (patch: Partial<DockerSimState>) => void;
	readDockerLog: () => string[];
	clearDockerLog: () => void;
	runUpdater: (options?: {
		env?: Record<string, string | undefined>;
		useIsolatedTools?: boolean;
		omitRuntimeScriptEnv?: boolean;
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
	failRollbackTag: boolean;
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
	const tmpRuntimeBaseDir = join(rootDir, 'tmp-base');
	const runtimeScriptPath = join(rootDir, 'runtime-dir', 'update.sh');
	const binDir = join(rootDir, 'bin');
	const dockerStateFile = join(rootDir, 'docker-state.json');
	const dockerLogFile = join(rootDir, 'docker-commands.log');

	mkdirSync(bareRepoDir, { recursive: true });
	mkdirSync(workRepoDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(tmpRuntimeBaseDir, { recursive: true });
	chmodSync(tmpRuntimeBaseDir, 0o777);
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
	writeFileSync(join(stateDir, 'deployed-state'), `${initialSha}\n${initialImage}\n`);

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
		failRollbackHealthCount: 0,
		failRollbackTag: false
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
	if (dst === 'flavorithm:rollback' && state.failRollbackTag) {
		process.stderr.write('simulated rollback tag failure\\n');
		process.exit(1);
	}
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
	let nextWorkflowRunId = 10000;
	const checkResponses = new Map<string, { statusCode: number; runs: Record<string, unknown>[] }>();
	const workflowRunResponses = new Map<
		string,
		{ statusCode: number; payload: Record<string, unknown> }
	>();

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? '';
		requests.push({
			method: req.method ?? 'GET',
			url,
			authorization:
				typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
		});

		const checkMatch = url.match(
			/^\/repos\/([^/]+)\/([^/]+)\/commits\/([0-9a-fA-F]{40})\/check-runs\?check_name=verify&filter=latest$/
		);
		if (checkMatch) {
			const sha = checkMatch[3].toLowerCase();
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
			return;
		}

		const runMatch = url.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/([0-9]+)$/);
		if (runMatch) {
			const runId = runMatch[3];
			const configuredRun = workflowRunResponses.get(runId);
			if (!configuredRun) {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ message: 'Not Found' }));
				return;
			}
			res.writeHead(configuredRun.statusCode, { 'content-type': 'application/json' });
			res.end(JSON.stringify(configuredRun.payload));
			return;
		}

		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ message: 'Not Found' }));
	});

	await new Promise<void>((resolveListen) => {
		server.listen(0, '127.0.0.1', () => resolveListen());
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const apiBaseUrl = `http://127.0.0.1:${address.port}`;

	function setCheckRuns(sha: string, runs: CheckRunFixture[], statusCode = 200) {
		const normalizedSha = sha.toLowerCase();
		const serializedRuns = runs.map((run, index) => {
			nextWorkflowRunId += 1;
			const runId = String(nextWorkflowRunId);
			const defaultUrl =
				run.app?.slug === 'github-actions'
					? `https://github.com/sgerner/flavorithm/actions/runs/${runId}/job/${index + 1}`
					: undefined;
			const detailsUrl = run.details_url === undefined ? defaultUrl : run.details_url;
			const htmlUrl = run.html_url === undefined ? detailsUrl : run.html_url;

			workflowRunResponses.set(runId, {
				statusCode: run.workflow_status_code ?? 200,
				payload: {
					id: Number(runId),
					path: run.workflow_path ?? '.github/workflows/ci.yml',
					head_sha: run.head_sha ?? normalizedSha,
					status: run.workflow_status ?? run.status,
					conclusion:
						run.workflow_conclusion === undefined ? run.conclusion : run.workflow_conclusion
				}
			});

			return {
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				app: run.app,
				head_sha: run.head_sha ?? normalizedSha,
				details_url: detailsUrl,
				html_url: htmlUrl
			};
		});
		checkResponses.set(normalizedSha, { statusCode, runs: serializedRuns });
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

	function readDeployedState(): DeployedState {
		const raw = readFileSync(join(stateDir, 'deployed-state'), 'utf8').split(/\r?\n/);
		return {
			sha: (raw[0] ?? '').trim(),
			image: (raw[1] ?? '').trim()
		};
	}

	function writeDeployedState(sha: string, image: string) {
		writeFileSync(join(stateDir, 'deployed-state'), `${sha}\n${image}\n`);
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
		omitRuntimeScriptEnv?: boolean;
	}) {
		let pathEnv = `${binDir}:${process.env.PATH ?? ''}`;
		let isolatedDir: string | undefined;
		if (options?.useIsolatedTools) {
			isolatedDir = mkdtempSync(join(rootDir, 'isolated-bin-'));
			for (const cmd of [
				'sh',
				'mkdir',
				'mktemp',
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
			TMPDIR: tmpRuntimeBaseDir,
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
		if (options?.omitRuntimeScriptEnv) {
			delete mergedEnv.FLAVORITHM_UPDATER_RUNTIME_SCRIPT;
		}

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
		tmpRuntimeBaseDir,
		runtimeScriptPath,
		binDir,
		dockerStateFile,
		dockerLogFile,
		requests,
		setCheckRuns,
		commitAndPush,
		readDeployedState,
		writeDeployedState,
		readDockerState,
		writeDockerState,
		readDockerLog,
		clearDockerLog,
		runUpdater,
		cleanup
	};
}

test('creates 0700 mktemp -d runtime copy by default, installs missing apk tools, skips GitHub API on deployed/failed SHA, and migrates legacy deployed-sha', async () => {
	const h = await createHarness();
	try {
		const upToDate = await h.runUpdater({ useIsolatedTools: true, omitRuntimeScriptEnv: true });
		assert.equal(upToDate.code, 0, upToDate.stderr);

		const tmpEntries = readdirSync(h.tmpRuntimeBaseDir);
		assert.equal(
			tmpEntries.includes('flavorithm-update.sh'),
			false,
			'Must not create predictable /tmp/flavorithm-update.sh'
		);
		const runtimeDirs = tmpEntries.filter((name) => name.startsWith('flavorithm-updater.'));
		assert.equal(runtimeDirs.length, 1, 'Expected one mktemp -d runtime directory');
		const createdRuntimeDir = join(h.tmpRuntimeBaseDir, runtimeDirs[0]);
		assert.equal(
			statSync(createdRuntimeDir).mode & 0o777,
			0o700,
			'Runtime directory must have mode 0700'
		);
		const createdScript = join(createdRuntimeDir, 'update.sh');
		assert.ok(existsSync(createdScript), 'Expected update.sh inside mktemp -d directory');
		assert.equal(statSync(createdScript).mode & 0o777, 0o700, 'Runtime script must have mode 0700');
		assert.deepEqual(
			readdirSync(createdRuntimeDir),
			['update.sh'],
			'Must not leave temporary staging files behind'
		);

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

		// Legacy deployment upgrade: seeds atomic deployed-state from legacy deployed-sha only when container is healthy
		rmSync(join(h.stateDir, 'deployed-state'), { force: true });
		rmSync(join(h.stateDir, 'failed-sha'), { force: true });
		writeFileSync(join(h.stateDir, 'deployed-sha'), `${failedSha}\n`);
		git(h.appDir, ['fetch', '--no-tags', h.bareRepoDir, failedSha]);
		git(h.appDir, ['checkout', '--force', failedSha]);
		h.writeDockerState({ containerHealth: 'unhealthy' });
		await h.runUpdater();
		assert.equal(
			existsSync(join(h.stateDir, 'deployed-state')),
			false,
			'Must never seed deployed-state image from an unhealthy container'
		);

		h.writeDockerState({ containerHealth: 'healthy' });
		await h.runUpdater();
		assert.deepEqual(h.readDeployedState(), {
			sha: failedSha,
			image: h.readDockerState().containerImage
		});
		assert.equal(existsSync(join(h.stateDir, 'deployed-sha')), false);
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
		assert.equal(h.requests.length, 2);
		assert.equal(
			h.requests[0].url,
			`/repos/sgerner/flavorithm/commits/${nextSha}/check-runs?check_name=verify&filter=latest`
		);
		assert.match(h.requests[1].url, /^\/repos\/sgerner\/flavorithm\/actions\/runs\/[0-9]+$/);
		assert.equal(h.requests[0].authorization, 'Bearer ghp_secretTestToken123');
		assert.equal(h.requests[1].authorization, 'Bearer ghp_secretTestToken123');
	} finally {
		await h.cleanup();
	}
});

test('gates deployment on .github/workflows/ci.yml verify check-run success and deploys once verified', async () => {
	const h = await createHarness();
	try {
		const initialState = h.readDeployedState();
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
			],
			[
				// Passing github-actions verify job from a different workflow file
				{
					name: 'verify',
					status: 'completed',
					conclusion: 'success',
					app: { slug: 'github-actions' },
					workflow_path: '.github/workflows/other.yml'
				}
			],
			[
				// Missing workflow run link on check-run (fail-closed)
				{
					name: 'verify',
					status: 'completed',
					conclusion: 'success',
					app: { slug: 'github-actions' },
					details_url: null,
					html_url: null
				}
			],
			[
				// Workflow run endpoint fails (fail-closed)
				{
					name: 'verify',
					status: 'completed',
					conclusion: 'success',
					app: { slug: 'github-actions' },
					workflow_status_code: 500
				}
			]
		];

		for (const runs of blockedFixtures) {
			h.setCheckRuns(candidateSha, runs);
			const skipped = await h.runUpdater();
			assert.equal(skipped.code, 0, skipped.stderr);
			assert.match(skipped.stdout, /verify check-run has not completed with success/);
			assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), initialState.sha);
			assert.deepEqual(h.readDeployedState(), initialState);
			assert.equal(existsSync(join(h.stateDir, 'failed-sha')), false);
		}

		// Once GitHub Actions .github/workflows/ci.yml verify finishes with success, the next poll deploys it
		h.setCheckRuns(candidateSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' },
				head_sha: candidateSha,
				workflow_path: '.github/workflows/ci.yml'
			}
		]);
		const deployed = await h.runUpdater();
		assert.equal(deployed.code, 0, deployed.stderr);
		assert.match(deployed.stdout, /Flavorithm updated successfully/);
		assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), candidateSha);
		assert.deepEqual(h.readDeployedState(), { sha: candidateSha, image: nextImage });
		assert.equal(h.readDockerState().tags['flavorithm:rollback'], nextImage);
		assert.equal(h.readDockerState().tags['flavorithm:local'], nextImage);
	} finally {
		await h.cleanup();
	}
});

test('resets /app to deployed_sha before rollback when compose.override.yml is invalid', async () => {
	const h = await createHarness();
	try {
		const { sha: initialSha, image: initialImage } = h.readDeployedState();

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
		assert.deepEqual(h.readDeployedState(), { sha: initialSha, image: initialImage });
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
		const { sha: initialSha, image: initialImage } = h.readDeployedState();
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
		assert.deepEqual(h.readDeployedState(), { sha: initialSha, image: initialImage });
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

test('preserves deployed-state image when Poll 1 rollback fails and retries recovery on Poll 2 without rebuilding', async () => {
	const h = await createHarness();
	try {
		const { sha: initialSha, image: initialImage } = h.readDeployedState();
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
		assert.deepEqual(h.readDeployedState(), { sha: initialSha, image: initialImage });
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
		assert.deepEqual(h.readDeployedState(), { sha: initialSha, image: initialImage });
		assert.equal(readFileSync(join(h.stateDir, 'failed-sha'), 'utf8').trim(), brokenSha);
		assert.equal(existsSync(join(h.stateDir, 'rollback-pending')), false);
		assert.equal(h.readDockerState().tags['flavorithm:local'], initialImage);
		assert.equal(h.readDockerState().containerImage, initialImage);
		assert.equal(h.readDockerState().containerHealth, 'healthy');
	} finally {
		await h.cleanup();
	}
});

test('writes deployed SHA and image atomically, treats rollback docker tag as non-fatal, and converges cleanly across crash windows', async () => {
	const h = await createHarness();
	try {
		// Part A: Non-fatal docker tag failure during healthy deploy still commits atomic deployed-state and clears rollback-pending
		const sha2 = h.commitAndPush({ 'version.txt': 'v2-nonfatal-tag\n' }, 'Non-fatal tag release');
		const image2 = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
		h.writeDockerState({
			nextBuildImage: image2,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[image2]: 'healthy'
			},
			failRollbackTag: true
		});
		h.setCheckRuns(sha2, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const deployNonFatalTag = await h.runUpdater();
		assert.equal(deployNonFatalTag.code, 0, deployNonFatalTag.stderr);
		assert.match(deployNonFatalTag.stdout, /Flavorithm updated successfully/);
		assert.deepEqual(h.readDeployedState(), { sha: sha2, image: image2 });
		assert.equal(existsSync(join(h.stateDir, 'rollback-pending')), false);
		assert.equal(existsSync(join(h.stateDir, 'failed-sha')), false);

		// Restore working docker tag so next poll repairs flavorithm:rollback from deployed-state
		h.writeDockerState({ failRollbackTag: false });

		// Part B: Crash BEFORE atomic deployed-state write (checkout & running container are at sha3/image3, but deployed-state is still sha2/image2 and rollback-pending is set)
		const sha3 = h.commitAndPush({ 'version.txt': 'v3-crash-before\n' }, 'Crash before commit');
		const image3 = 'sha256:3434343434343434343434343434343434343434343434343434343434343434';
		git(h.appDir, ['fetch', '--no-tags', h.bareRepoDir, sha3]);
		git(h.appDir, ['checkout', '--force', sha3]);
		h.writeDockerState({
			containerImage: image3,
			containerHealth: 'healthy',
			nextBuildImage: image3,
			tags: {
				'flavorithm:local': image3,
				'flavorithm:rollback': image2
			},
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[image2]: 'healthy',
				[image3]: 'healthy'
			}
		});
		writeFileSync(join(h.stateDir, 'rollback-pending'), 'recover\n');
		h.setCheckRuns(sha3, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const recoverBeforeWrite = await h.runUpdater();
		assert.equal(recoverBeforeWrite.code, 0, recoverBeforeWrite.stderr);
		assert.match(recoverBeforeWrite.stdout, new RegExp(`Rollback to ${sha2} succeeded`));
		assert.equal(
			git(h.appDir, ['rev-parse', 'HEAD']),
			sha2,
			'Must restore checkout to sha2 matching image2'
		);
		assert.equal(
			h.readDockerState().containerImage,
			image2,
			'Must restore container image to image2 matching sha2 (never pairing image3 with sha2)'
		);
		assert.deepEqual(h.readDeployedState(), { sha: sha2, image: image2 });
		assert.equal(existsSync(join(h.stateDir, 'rollback-pending')), false);
		assert.equal(
			existsSync(join(h.stateDir, 'failed-sha')),
			false,
			'Interrupted healthy commit must not be marked failed-sha'
		);

		// Next poll cleanly deploys sha3/image3
		const redeployAfterRecover = await h.runUpdater();
		assert.equal(redeployAfterRecover.code, 0, redeployAfterRecover.stderr);
		assert.match(redeployAfterRecover.stdout, /Flavorithm updated successfully/);
		assert.deepEqual(h.readDeployedState(), { sha: sha3, image: image3 });

		// Part C: Crash IMMEDIATELY AFTER atomic deployed-state write (deployed-state is sha4/image4, but rollback-pending still exists and flavorithm:rollback still points to image3)
		const sha4 = h.commitAndPush({ 'version.txt': 'v4-crash-after\n' }, 'Crash after commit');
		const image4 = 'sha256:4545454545454545454545454545454545454545454545454545454545454545';
		git(h.appDir, ['fetch', '--no-tags', h.bareRepoDir, sha4]);
		git(h.appDir, ['checkout', '--force', sha4]);
		h.writeDeployedState(sha4, image4);
		writeFileSync(join(h.stateDir, 'rollback-pending'), 'recover\n');
		h.writeDockerState({
			containerImage: image4,
			containerHealth: 'healthy',
			tags: {
				'flavorithm:local': image4,
				'flavorithm:rollback': image3
			},
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[image4]: 'healthy'
			}
		});

		const recoverAfterWrite = await h.runUpdater();
		assert.equal(recoverAfterWrite.code, 0, recoverAfterWrite.stderr);
		assert.match(recoverAfterWrite.stdout, new RegExp(`Rollback to ${sha4} succeeded`));
		assert.equal(
			git(h.appDir, ['rev-parse', 'HEAD']),
			sha4,
			'Checkout must converge to sha4 matching image4'
		);
		assert.equal(
			h.readDockerState().containerImage,
			image4,
			'Container image must converge to image4 matching sha4'
		);
		assert.equal(h.readDockerState().tags['flavorithm:rollback'], image4);
		assert.deepEqual(h.readDeployedState(), { sha: sha4, image: image4 });
		assert.equal(existsSync(join(h.stateDir, 'rollback-pending')), false);
		assert.equal(existsSync(join(h.stateDir, 'failed-sha')), false);
	} finally {
		await h.cleanup();
	}
});

test('treats missing or invalid deployed SHA as no rollback target, clears pending marker, and continues deploying', async () => {
	const h = await createHarness();
	try {
		// Part A: Empty state directory + pre-existing rollback-pending marker
		rmSync(join(h.stateDir, 'deployed-state'), { force: true });
		writeFileSync(join(h.stateDir, 'rollback-pending'), 'recover\n');

		const sha2 = h.commitAndPush({ 'version.txt': 'v2-from-empty\n' }, 'Deploy from empty state');
		const image2 = 'sha256:5656565656565656565656565656565656565656565656565656565656565656';
		h.writeDockerState({
			nextBuildImage: image2,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[image2]: 'healthy'
			}
		});
		h.setCheckRuns(sha2, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const emptyStateDeploy = await h.runUpdater();
		assert.equal(emptyStateDeploy.code, 0, emptyStateDeploy.stderr);
		assert.match(emptyStateDeploy.stdout, /No rollback target.*clearing pending rollback marker/);
		assert.match(emptyStateDeploy.stdout, /Flavorithm updated successfully/);
		assert.equal(existsSync(join(h.stateDir, 'rollback-pending')), false);
		assert.deepEqual(h.readDeployedState(), { sha: sha2, image: image2 });

		// Part B: Invalid deployed SHA in deployed-state + pre-existing rollback-pending marker
		h.writeDeployedState('not-a-valid-40-char-sha', image2);
		writeFileSync(join(h.stateDir, 'rollback-pending'), `${sha2}\n`);

		const sha3 = h.commitAndPush(
			{ 'version.txt': 'v3-from-invalid\n' },
			'Deploy from invalid state'
		);
		const image3 = 'sha256:6767676767676767676767676767676767676767676767676767676767676767';
		h.writeDockerState({
			nextBuildImage: image3,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[image3]: 'healthy'
			}
		});
		h.setCheckRuns(sha3, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const invalidStateDeploy = await h.runUpdater();
		assert.equal(invalidStateDeploy.code, 0, invalidStateDeploy.stderr);
		assert.match(invalidStateDeploy.stdout, /No rollback target.*clearing pending rollback marker/);
		assert.match(invalidStateDeploy.stdout, /Flavorithm updated successfully/);
		assert.equal(existsSync(join(h.stateDir, 'rollback-pending')), false);
		assert.deepEqual(h.readDeployedState(), { sha: sha3, image: image3 });

		// Part C: Initial deploy fails when no deployed-state exists yet, then subsequent healthy commit deploys without wedging
		rmSync(join(h.stateDir, 'deployed-state'), { force: true });
		const brokenSha = h.commitAndPush(
			{ 'version.txt': 'v4-initial-fail\n' },
			'Broken initial deploy'
		);
		const brokenImage = 'sha256:7878787878787878787878787878787878787878787878787878787878787878';
		h.writeDockerState({
			nextBuildImage: brokenImage,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[brokenImage]: 'unhealthy'
			}
		});
		h.setCheckRuns(brokenSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const failedInitialPoll = await h.runUpdater();
		assert.equal(failedInitialPoll.code, 0, failedInitialPoll.stderr);
		assert.match(
			failedInitialPoll.stdout,
			/No rollback target: no valid deployed SHA recorded; clearing pending rollback marker/
		);
		assert.equal(
			existsSync(join(h.stateDir, 'rollback-pending')),
			false,
			'Must clear rollback-pending when no rollback target exists'
		);
		assert.equal(readFileSync(join(h.stateDir, 'failed-sha'), 'utf8').trim(), brokenSha);

		const fixedSha = h.commitAndPush({ 'version.txt': 'v5-recovered\n' }, 'Healthy follow-up');
		const fixedImage = 'sha256:8989898989898989898989898989898989898989898989898989898989898989';
		h.writeDockerState({
			nextBuildImage: fixedImage,
			imageHealthMap: {
				...h.readDockerState().imageHealthMap,
				[fixedImage]: 'healthy'
			}
		});
		h.setCheckRuns(fixedSha, [
			{
				name: 'verify',
				status: 'completed',
				conclusion: 'success',
				app: { slug: 'github-actions' }
			}
		]);

		const recoveredPoll = await h.runUpdater();
		assert.equal(recoveredPoll.code, 0, recoveredPoll.stderr);
		assert.match(recoveredPoll.stdout, /Flavorithm updated successfully/);
		assert.deepEqual(h.readDeployedState(), { sha: fixedSha, image: fixedImage });
	} finally {
		await h.cleanup();
	}
});

test('isolates active mktemp -d runtime script from corrupted update.sh during rollback and re-executes healthy script updates', async () => {
	const h = await createHarness();
	try {
		const { sha: initialSha } = h.readDeployedState();

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

		const rollbackRes = await h.runUpdater({ omitRuntimeScriptEnv: true });
		assert.equal(rollbackRes.code, 0, rollbackRes.stderr);
		assert.match(rollbackRes.stdout, /Rollback to .* succeeded/);
		assert.equal(git(h.appDir, ['rev-parse', 'HEAD']), initialSha);

		// Clear previous mktemp -d directory before testing self-update re-execution
		for (const entry of readdirSync(h.tmpRuntimeBaseDir)) {
			rmSync(join(h.tmpRuntimeBaseDir, entry), { recursive: true, force: true });
		}

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

		const selfUpdateRes = await h.runUpdater({ omitRuntimeScriptEnv: true });
		assert.equal(selfUpdateRes.code, 0, selfUpdateRes.stderr);
		assert.match(selfUpdateRes.stdout, /Flavorithm updated successfully/);
		assert.match(selfUpdateRes.stdout, /Updater script changed; re-executing/);
		assert.match(selfUpdateRes.stdout, /re-executed-updated-script-v2/);
		assert.match(selfUpdateRes.stdout, new RegExp(`No update detected \\(${selfUpdateSha}\\)`));
		assert.deepEqual(h.readDeployedState(), { sha: selfUpdateSha, image: nextImage });

		const runtimeDirs = readdirSync(h.tmpRuntimeBaseDir).filter((name) =>
			name.startsWith('flavorithm-updater.')
		);
		assert.equal(
			runtimeDirs.length,
			1,
			'Self-update exec must reuse the same 0700 mktemp -d runtime directory'
		);
		const runtimeDir = join(h.tmpRuntimeBaseDir, runtimeDirs[0]);
		assert.equal(statSync(runtimeDir).mode & 0o777, 0o700);
		assert.equal(readFileSync(join(runtimeDir, 'update.sh'), 'utf8'), updatedScript);
	} finally {
		await h.cleanup();
	}
});
