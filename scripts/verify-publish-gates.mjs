import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_WORKFLOWS = [
	['CI', '.github/workflows/ci.yml'],
	['Security', '.github/workflows/security.yml']
];

const MANIFEST_ACCEPT_HEADER = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

const REPOSITORY_PATTERN = /^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_PAGES = 50;
const PER_PAGE = 100;

export function normalizeWorkflowPath(rawPath) {
	if (typeof rawPath !== 'string') return '';
	const atIndex = rawPath.indexOf('@');
	return (atIndex === -1 ? rawPath : rawPath.slice(0, atIndex)).replace(/^\/+/, '');
}

function parseNextLink(linkHeader, expectedOrigin) {
	if (typeof linkHeader !== 'string' || !linkHeader.trim()) return null;
	for (const segment of linkHeader.split(',')) {
		if (!/;\s*rel="next"(?:\s*;|\s*$)/.test(segment)) continue;
		const match = segment.match(/<([^>]+)>/);
		if (!match?.[1]) continue;
		const nextUrl = new URL(match[1]);
		if (nextUrl.origin !== expectedOrigin) {
			throw new Error('Refusing cross-origin pagination link from GitHub API.');
		}
		return nextUrl;
	}
	return null;
}

function isNewerRun(candidate, current) {
	if (!current) return true;
	if (candidate.run_number !== current.run_number) {
		return candidate.run_number > current.run_number;
	}
	const candidateAttempt = typeof candidate.run_attempt === 'number' ? candidate.run_attempt : 1;
	const currentAttempt = typeof current.run_attempt === 'number' ? current.run_attempt : 1;
	if (candidateAttempt !== currentAttempt) {
		return candidateAttempt > currentAttempt;
	}
	return (candidate.id ?? 0) > (current.id ?? 0);
}

async function fetchWorkflowRuns({ githubApiBase, repository, headSha, token, fetchImpl }) {
	const baseHref = githubApiBase.href.replace(/\/+$/, '');
	const [owner, repo] = repository.split('/');
	const makePageUrl = (page) => {
		const url = new URL(`${baseHref}/repos/${owner}/${repo}/actions/runs`);
		url.searchParams.set('head_sha', headSha);
		url.searchParams.set('event', 'push');
		url.searchParams.set('branch', 'main');
		url.searchParams.set('per_page', String(PER_PAGE));
		url.searchParams.set('page', String(page));
		return url;
	};

	const runs = [];
	let page = 1;
	let nextUrl = makePageUrl(page);

	while (nextUrl) {
		if (page > MAX_PAGES) {
			throw new Error('Exceeded pagination limit while listing GitHub workflow runs.');
		}
		const response = await fetchImpl(nextUrl, {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'flavorithm-publish-gate'
			},
			redirect: 'error',
			signal: AbortSignal.timeout(15_000)
		});
		if (!response.ok) {
			throw new Error(`GitHub workflow runs request failed (${response.status}).`);
		}
		const data = await response.json();
		if (!Array.isArray(data?.workflow_runs)) {
			throw new Error('GitHub workflow runs response did not contain a workflow_runs array.');
		}
		runs.push(...data.workflow_runs);

		const linkedNext = parseNextLink(response.headers.get('link'), githubApiBase.origin);
		if (linkedNext) {
			nextUrl = linkedNext;
			page += 1;
		} else if (
			typeof data.total_count === 'number' &&
			runs.length < data.total_count &&
			data.workflow_runs.length === PER_PAGE
		) {
			page += 1;
			nextUrl = makePageUrl(page);
		} else {
			nextUrl = null;
		}
	}

	return runs;
}

async function checkGhcrTagExists({ ghcrBase, repository, actor, token, tag, fetchImpl }) {
	const baseHref = ghcrBase.href.replace(/\/+$/, '');
	const imageRepository = repository.toLowerCase();
	const tokenUrl = new URL(`${baseHref}/token`);
	tokenUrl.searchParams.set('service', 'ghcr.io');
	tokenUrl.searchParams.set('scope', `repository:${imageRepository}:pull`);

	const basicCredentials = Buffer.from(`${actor}:${token}`, 'utf8').toString('base64');
	const tokenResponse = await fetchImpl(tokenUrl, {
		headers: {
			Accept: 'application/json',
			Authorization: `Basic ${basicCredentials}`,
			'User-Agent': 'flavorithm-publish-gate'
		},
		redirect: 'error',
		signal: AbortSignal.timeout(15_000)
	});
	if (!tokenResponse.ok) {
		throw new Error(`GHCR token login failed (${tokenResponse.status}).`);
	}
	const tokenPayload = await tokenResponse.json();
	const registryToken = tokenPayload?.token || tokenPayload?.access_token;
	if (typeof registryToken !== 'string' || !registryToken.trim()) {
		throw new Error('GHCR token login response did not include a pull token.');
	}

	const manifestUrl = new URL(`${baseHref}/v2/${imageRepository}/manifests/${tag}`);
	const manifestResponse = await fetchImpl(manifestUrl, {
		headers: {
			Accept: MANIFEST_ACCEPT_HEADER,
			Authorization: `Bearer ${registryToken}`,
			'User-Agent': 'flavorithm-publish-gate'
		},
		redirect: 'error',
		signal: AbortSignal.timeout(15_000)
	});
	if (manifestResponse.status === 200) return true;
	if (manifestResponse.status === 404) return false;
	throw new Error(`GHCR manifest inspection failed (${manifestResponse.status}).`);
}

export async function verifyPublishGates({ env = process.env, event, fetchImpl = fetch } = {}) {
	const token = env.GITHUB_TOKEN?.trim() ?? '';
	if (!token) {
		throw new Error('GITHUB_TOKEN is required to verify publish gates.');
	}

	let parsedEvent = event;
	if (!parsedEvent) {
		const eventPath = env.GITHUB_EVENT_PATH?.trim();
		if (!eventPath) {
			throw new Error('GITHUB_EVENT_PATH is required to read the workflow_run payload.');
		}
		parsedEvent = JSON.parse(readFileSync(eventPath, 'utf8'));
	}

	if (env.GITHUB_EVENT_NAME && env.GITHUB_EVENT_NAME !== 'workflow_run') {
		return { ready: false, reason: `ignoring ${env.GITHUB_EVENT_NAME} trigger` };
	}

	const repository =
		env.GITHUB_REPOSITORY?.trim() || parsedEvent?.repository?.full_name?.trim() || '';
	if (!REPOSITORY_PATTERN.test(repository)) {
		throw new Error('GITHUB_REPOSITORY must be set in owner/repo format.');
	}

	const workflowRun = parsedEvent?.workflow_run;
	if (!workflowRun || typeof workflowRun !== 'object') {
		throw new Error('Event payload does not contain a workflow_run object.');
	}

	if (workflowRun.event !== 'push') {
		return { ready: false, reason: `ignoring ${workflowRun.event || 'non-push'} workflow_run` };
	}
	if (workflowRun.head_branch !== 'main') {
		return { ready: false, reason: `ignoring branch ${workflowRun.head_branch || 'unknown'}` };
	}
	if (
		workflowRun.head_repository?.fork === true ||
		typeof workflowRun.head_repository?.full_name !== 'string' ||
		workflowRun.head_repository.full_name.toLowerCase() !== repository.toLowerCase()
	) {
		return { ready: false, reason: 'ignoring fork or external repository workflow_run' };
	}

	if (typeof workflowRun.head_sha !== 'string' || !COMMIT_SHA_PATTERN.test(workflowRun.head_sha)) {
		throw new Error('workflow_run.head_sha must be a 40-character hexadecimal commit SHA.');
	}
	const headSha = workflowRun.head_sha.toLowerCase();

	if (workflowRun.status !== 'completed' || workflowRun.conclusion !== 'success') {
		return {
			ready: false,
			reason: `triggering workflow run did not succeed (${workflowRun.status ?? 'unknown'}/${workflowRun.conclusion ?? 'none'})`
		};
	}

	const githubApiBase = new URL(env.GITHUB_API_URL?.trim() || 'https://api.github.com');
	const ghcrBase = new URL(env.GHCR_URL?.trim() || 'https://ghcr.io');
	const runs = await fetchWorkflowRuns({
		githubApiBase,
		repository,
		headSha,
		token,
		fetchImpl
	});

	const latestByPath = new Map();
	const requiredPaths = new Set(REQUIRED_WORKFLOWS.map(([, path]) => path));

	for (const run of runs) {
		if (!run || typeof run !== 'object') continue;
		if (typeof run.head_sha === 'string' && run.head_sha.toLowerCase() !== headSha) continue;
		if (typeof run.event === 'string' && run.event !== 'push') continue;
		if (typeof run.head_branch === 'string' && run.head_branch !== 'main') continue;
		if (run.head_repository?.fork === true) continue;
		if (
			typeof run.head_repository?.full_name === 'string' &&
			run.head_repository.full_name.toLowerCase() !== repository.toLowerCase()
		) {
			continue;
		}
		const normalizedPath = normalizeWorkflowPath(run.path);
		if (!requiredPaths.has(normalizedPath)) continue;
		if (typeof run.run_number !== 'number' || !Number.isFinite(run.run_number)) {
			throw new Error(`Workflow run for ${normalizedPath} is missing a numeric run_number.`);
		}
		if (isNewerRun(run, latestByPath.get(normalizedPath))) {
			latestByPath.set(normalizedPath, run);
		}
	}

	for (const [label, workflowPath] of REQUIRED_WORKFLOWS) {
		const latest = latestByPath.get(workflowPath);
		if (!latest) {
			return { ready: false, reason: `${label} push run has not been recorded yet` };
		}
		if (latest.status !== 'completed') {
			return {
				ready: false,
				reason: `${label} push run #${latest.run_number} is ${latest.status}`
			};
		}
		if (latest.conclusion !== 'success') {
			return {
				ready: false,
				reason: `${label} push run #${latest.run_number} concluded with ${latest.conclusion ?? 'none'}`
			};
		}
	}

	const tag = `sha-${headSha}`;
	const actor = env.GITHUB_ACTOR?.trim() || repository.split('/')[0];
	const alreadyPublished = await checkGhcrTagExists({
		ghcrBase,
		repository,
		actor,
		token,
		tag,
		fetchImpl
	});
	if (alreadyPublished) {
		return { ready: false, reason: `tag ${tag} already exists in ghcr.io` };
	}

	return {
		ready: true,
		reason: `CI and Security push runs succeeded and ${tag} is not in ghcr.io`
	};
}

function redactSecret(message, secret) {
	if (!secret) return message;
	return message.replaceAll(secret, '[redacted]');
}

async function main() {
	const result = await verifyPublishGates();
	const outputPath = process.env.GITHUB_OUTPUT?.trim();
	if (outputPath) {
		appendFileSync(outputPath, `ready=${result.ready}\n`, 'utf8');
	}
	console.log(`ready=${result.ready} (${result.reason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		const rawMessage = error instanceof Error ? error.message : String(error);
		console.error(redactSecret(rawMessage, process.env.GITHUB_TOKEN?.trim() ?? ''));
		process.exitCode = 1;
	});
}
