import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

interface PackageManifest {
	devDependencies?: Record<string, string>;
	engines?: {
		node?: string;
	};
}

interface PackageLockManifest {
	packages?: Record<
		string,
		{
			version?: string;
			devDependencies?: Record<string, string>;
			engines?: {
				node?: string;
			};
		}
	>;
}

interface ToolchainSnapshot {
	nvmrc: string;
	npmrc: string;
	packageJson: PackageManifest;
	packageLock: PackageLockManifest;
	dockerfile: string;
	workflows: Record<string, string>;
	dependabot: string;
}

function parseNpmrc(contents: string): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const separatorIndex = line.indexOf('=');
		if (separatorIndex === -1) continue;
		const key = line.slice(0, separatorIndex).trim();
		const value = line.slice(separatorIndex + 1).trim();
		entries[key] = value;
	}
	return entries;
}

function parseDockerfileStages(dockerfile: string): Array<{ from: string; body: string[] }> {
	const stages: Array<{ from: string; body: string[] }> = [];
	const logicalLines: string[] = [];
	let current = '';

	for (const rawLine of dockerfile.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		if (trimmed.endsWith('\\')) {
			current += `${trimmed.slice(0, -1).trimEnd()} `;
		} else {
			current += trimmed;
			logicalLines.push(current.trim());
			current = '';
		}
	}
	if (current.trim()) {
		logicalLines.push(current.trim());
	}

	for (const line of logicalLines) {
		const fromMatch = line.match(/^FROM\s+(\S+)(?:\s+AS\s+\S+)?$/i);
		if (fromMatch) {
			stages.push({ from: fromMatch[1], body: [] });
		} else if (stages.length > 0) {
			stages[stages.length - 1].body.push(line);
		}
	}
	return stages;
}

function hasDependabotMajorIgnore(
	dependabotYaml: string,
	ecosystem: string,
	dependencyName: string
): boolean {
	const blocks = dependabotYaml.split(/^\s*-\s+package-ecosystem:\s*/m).slice(1);
	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		const blockEcosystem = lines[0]?.trim().replace(/^['"]|['"]$/g, '');
		if (blockEcosystem !== ecosystem) continue;

		const ignoreSectionMatch = block.match(/^\s{4}ignore:\s*\r?\n((?:\s{6,}.*\r?\n?)*)/m);
		if (!ignoreSectionMatch) return false;

		const ignoreItems = ignoreSectionMatch[1].split(/^\s{6}-\s+/m).slice(1);
		for (const item of ignoreItems) {
			const depMatch = item.match(/dependency-name:\s*['"]?([^'"\r\n]+)['"]?/);
			const ignoresMajor = /update-types:[\s\S]*?version-update:semver-major/.test(item);
			if (depMatch?.[1]?.trim() === dependencyName && ignoresMajor) {
				return true;
			}
		}
	}
	return false;
}

function assertNodeToolchainParity(snapshot: ToolchainSnapshot): void {
	const majorVersion = snapshot.nvmrc.trim();
	assert.equal(majorVersion, '24', '.nvmrc must pin Node.js major version 24');
	const majorNumber = Number(majorVersion);
	const nextMajor = majorNumber + 1;

	const npmrcSettings = parseNpmrc(snapshot.npmrc);
	assert.equal(
		npmrcSettings['engine-strict'],
		'true',
		'.npmrc must set engine-strict=true to block incompatible Node.js versions'
	);

	const expectedEngineRange = `>=${majorVersion}.19.0 <${nextMajor}.0.0`;
	assert.equal(
		snapshot.packageJson.engines?.node,
		expectedEngineRange,
		`package.json engines.node must equal "${expectedEngineRange}"`
	);

	const typesNodeSpec = snapshot.packageJson.devDependencies?.['@types/node'];
	assert.ok(typesNodeSpec, 'package.json must declare @types/node in devDependencies');
	assert.match(
		typesNodeSpec,
		new RegExp(`^\\^${majorVersion}\\.`),
		`package.json @types/node (${typesNodeSpec}) must target Node.js ${majorVersion}`
	);
	assert.equal(typesNodeSpec, '^24.19.2', 'package.json @types/node must align to ^24.19.2');

	const lockRoot = snapshot.packageLock.packages?.[''];
	assert.ok(lockRoot, 'package-lock.json must include root package metadata');
	assert.equal(
		lockRoot.engines?.node,
		expectedEngineRange,
		'package-lock.json root engines.node must match package.json'
	);
	assert.equal(
		lockRoot.devDependencies?.['@types/node'],
		typesNodeSpec,
		'package-lock.json root @types/node spec must match package.json'
	);

	const lockedTypesNode = snapshot.packageLock.packages?.['node_modules/@types/node'];
	assert.ok(lockedTypesNode?.version, 'package-lock.json must resolve node_modules/@types/node');
	assert.match(
		lockedTypesNode.version,
		new RegExp(`^${majorVersion}\\.`),
		`package-lock.json node_modules/@types/node (${lockedTypesNode.version}) must resolve to ${majorVersion}.x`
	);

	const stages = parseDockerfileStages(snapshot.dockerfile);
	const nodeStages = stages.filter((stage) => stage.from.startsWith('node:'));
	assert.ok(nodeStages.length >= 3, 'Dockerfile must define Node.js base stages');
	for (const stage of nodeStages) {
		assert.equal(
			stage.from,
			`node:${majorVersion}-bookworm-slim`,
			`Dockerfile stage base image (${stage.from}) must pin node:${majorVersion}-bookworm-slim`
		);
	}

	const installStages = stages.filter((stage) =>
		stage.body.some((line) => /^RUN\s+.*\bnpm\s+ci\b/.test(line))
	);
	assert.equal(
		installStages.length,
		2,
		'Dockerfile must have dependencies and production-dependencies npm ci stages'
	);
	for (const stage of installStages) {
		const npmCiIndex = stage.body.findIndex((line) => /^RUN\s+.*\bnpm\s+ci\b/.test(line));
		const copiedBeforeInstall = stage.body.slice(0, npmCiIndex);
		const copiesNpmrc = copiedBeforeInstall.some(
			(line) => /^COPY\s+/.test(line) && /(?:^|\s)\.npmrc(?:\s|$)/.test(line)
		);
		assert.ok(
			copiesNpmrc,
			'Every Dockerfile stage running npm ci must COPY .npmrc beforehand so engine-strict applies'
		);
	}

	let setupNodeWorkflowCount = 0;
	for (const [workflowName, workflowYaml] of Object.entries(snapshot.workflows)) {
		const setupNodeMatches = [...workflowYaml.matchAll(/uses:\s*actions\/setup-node@[^\r\n]+/g)];
		if (setupNodeMatches.length === 0) continue;
		setupNodeWorkflowCount += setupNodeMatches.length;

		assert.doesNotMatch(
			workflowYaml,
			/^\s*node-version\s*:/m,
			`${workflowName} must not hardcode node-version; use node-version-file: .nvmrc`
		);
		const versionFileMatches = [
			...workflowYaml.matchAll(/^\s*node-version-file:\s*['"]?\.nvmrc['"]?\s*$/gm)
		];
		assert.equal(
			versionFileMatches.length,
			setupNodeMatches.length,
			`${workflowName} must set node-version-file: .nvmrc on every actions/setup-node step`
		);
	}
	assert.ok(
		setupNodeWorkflowCount >= 2,
		'Expected ci.yml and security.yml workflows to configure actions/setup-node'
	);

	assert.ok(
		hasDependabotMajorIgnore(snapshot.dependabot, 'npm', '@types/node'),
		'.github/dependabot.yml must ignore version-update:semver-major for @types/node in npm'
	);
	assert.ok(
		hasDependabotMajorIgnore(snapshot.dependabot, 'docker', 'node'),
		'.github/dependabot.yml must ignore version-update:semver-major for node in docker'
	);
}

function loadRepositorySnapshot(): ToolchainSnapshot {
	const workflowsDir = resolve('.github/workflows');
	const workflows: Record<string, string> = {};
	for (const entry of readdirSync(workflowsDir).sort()) {
		if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
			workflows[entry] = readFileSync(resolve(workflowsDir, entry), 'utf8');
		}
	}

	return {
		nvmrc: readFileSync(resolve('.nvmrc'), 'utf8'),
		npmrc: readFileSync(resolve('.npmrc'), 'utf8'),
		packageJson: JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as PackageManifest,
		packageLock: JSON.parse(
			readFileSync(resolve('package-lock.json'), 'utf8')
		) as PackageLockManifest,
		dockerfile: readFileSync(resolve('Dockerfile'), 'utf8'),
		workflows,
		dependabot: readFileSync(resolve('.github/dependabot.yml'), 'utf8')
	};
}

test('repository manifests, Docker stages, workflows, and Dependabot align on Node.js 24 LTS', () => {
	const snapshot = loadRepositorySnapshot();
	assertNodeToolchainParity(snapshot);
});

test('toolchain parity check rejects mismatched runtime, types, Docker, workflow, and Dependabot edits', () => {
	const baseline = loadRepositorySnapshot();

	assert.throws(
		() =>
			assertNodeToolchainParity({
				...baseline,
				packageJson: {
					...baseline.packageJson,
					devDependencies: { ...baseline.packageJson.devDependencies, '@types/node': '^26.6.6' }
				}
			}),
		/@types\/node/
	);

	assert.throws(
		() =>
			assertNodeToolchainParity({
				...baseline,
				npmrc: 'engine-strict=false\n'
			}),
		/engine-strict/
	);

	assert.throws(
		() =>
			assertNodeToolchainParity({
				...baseline,
				dockerfile: baseline.dockerfile.replace(
					'FROM node:24-bookworm-slim AS runtime',
					'FROM node:26-bookworm-slim AS runtime'
				)
			}),
		/node:24-bookworm-slim/
	);

	assert.throws(
		() =>
			assertNodeToolchainParity({
				...baseline,
				dockerfile: baseline.dockerfile.replace(
					'COPY .npmrc package.json package-lock.json ./',
					'COPY package.json package-lock.json ./'
				)
			}),
		/COPY \.npmrc/
	);

	assert.throws(
		() =>
			assertNodeToolchainParity({
				...baseline,
				workflows: {
					...baseline.workflows,
					'ci.yml': baseline.workflows['ci.yml'].replace(
						'node-version-file: .nvmrc',
						'node-version: 24'
					)
				}
			}),
		/must not hardcode node-version/
	);

	assert.throws(
		() =>
			assertNodeToolchainParity({
				...baseline,
				dependabot: baseline.dependabot.replace('dependency-name: node', 'dependency-name: alpine')
			}),
		/dependabot\.yml.*node in docker/
	);
});
