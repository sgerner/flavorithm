import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, parse } from 'svelte/compiler';

function readRepoFile(relativePath: string): string {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('ToggleButton and DisclosureButton compile cleanly for client and server without external UI dependencies', () => {
	const toggleSource = readRepoFile('src/lib/components/ToggleButton.svelte');
	const disclosureSource = readRepoFile('src/lib/components/DisclosureButton.svelte');

	const toggleServer = compile(toggleSource, {
		filename: 'ToggleButton.svelte',
		generate: 'server'
	});
	const toggleClient = compile(toggleSource, {
		filename: 'ToggleButton.svelte',
		generate: 'client'
	});
	assert.equal(toggleServer.warnings.length, 0);
	assert.equal(toggleClient.warnings.length, 0);
	assert.match(toggleSource, /aria-pressed=\{pressed\}/);
	assert.match(toggleSource, /aria-label=\{label\}/);

	const disclosureServer = compile(disclosureSource, {
		filename: 'DisclosureButton.svelte',
		generate: 'server'
	});
	const disclosureClient = compile(disclosureSource, {
		filename: 'DisclosureButton.svelte',
		generate: 'client'
	});
	assert.equal(disclosureServer.warnings.length, 0);
	assert.equal(disclosureClient.warnings.length, 0);
	assert.match(disclosureSource, /aria-expanded=\{expanded\}/);
	assert.match(disclosureSource, /aria-controls=\{controls\}/);
});

test('RecipeDetail uses ToggleButton for cooking steps with zero-padded step numbers and invariant names', () => {
	const source = readRepoFile('src/lib/components/RecipeDetail.svelte');
	const compiled = compile(source, { filename: 'RecipeDetail.svelte', generate: 'server' });
	assert.equal(compiled.warnings.length, 0);

	assert.match(source, /import ToggleButton from '#lib\/components\/ToggleButton\.svelte'/);
	assert.doesNotMatch(source, /Mark step \$\{i \+ 1\}/);
	assert.match(source, /padStart\(\s*2,\s*'0'\s*\)/);
	assert.match(source, /<span class="visually-hidden">\{'Step '\}<\/span>/);
});

test('SyncStatus uses DisclosureButton with aria-expanded synchronized to reviewOpen and invariant label', () => {
	const source = readRepoFile('src/lib/components/SyncStatus.svelte');
	const compiled = compile(source, { filename: 'SyncStatus.svelte', generate: 'server' });
	assert.equal(compiled.warnings.length, 0);

	assert.match(source, /import DisclosureButton from '#lib\/components\/DisclosureButton\.svelte'/);
	assert.match(source, /expanded=\{reviewOpen\}/);
	assert.doesNotMatch(source, /Hide changes/);
	assert.match(source, />Review changes<\/DisclosureButton/);
});

test('pantry, hidden-recipe filter, and color mode controls expose explicit labels, groups, and static toggle names', () => {
	const pageSource = readRepoFile('src/routes/+page.svelte');
	const cssSource = readRepoFile('src/app.css');
	const ast = parse(pageSource, { modern: true });
	assert.ok(ast.fragment);

	const compiled = compile(pageSource, { filename: '+page.svelte', generate: 'server' });
	assert.equal(compiled.warnings.length, 0);

	// No mobile CSS pseudo-element label override
	assert.doesNotMatch(cssSource, /\.pantry-row\s*>\s*label::before/);

	// Expiry filter group with separated item counts
	assert.match(
		pageSource,
		/class="expiry-filters"\s+role="group"\s+aria-label="Filter pantry by expiry"/
	);
	assert.match(pageSource, /<span class="visually-hidden">\{', '\}<\/span>/);

	// Pantry row group and explicit H44 labels starting with Amount, Unit, Best before
	assert.match(
		pageSource,
		/class="pantry-row"[\s\S]*?role="group"[\s\S]*?aria-labelledby=\{`pantry-item-\$\{itemDomId\}`\}/
	);
	assert.match(
		pageSource,
		/<label class="pantry-field-label" for=\{`pantry-amount-\$\{itemDomId\}`\}[\s\S]*?><span>Amount<\/span><span class="visually-hidden"\s*>\{` of \$\{item\.name\}`\}<\/span\s*>/
	);
	assert.match(
		pageSource,
		/<label class="pantry-field-label" for=\{`pantry-unit-\$\{itemDomId\}`\}[\s\S]*?><span>Unit<\/span><span class="visually-hidden"\s*>\{` for \$\{item\.name\}`\}<\/span\s*>/
	);
	assert.match(
		pageSource,
		/<label class="pantry-field-label" for=\{`pantry-expiry-\$\{itemDomId\}`\}[\s\S]*?><span>Best before<\/span><span class="visually-hidden"\s*>\{` for \$\{item\.name\}`\}<\/span\s*>/
	);

	// Static toggle names without double negation
	assert.doesNotMatch(pageSource, /Hide hidden recipes|Show hidden recipes\}<\/button/);
	assert.doesNotMatch(pageSource, /aria-label="Switch color mode"/);
	assert.match(pageSource, />Hidden recipes<\/ToggleButton/);
	assert.match(pageSource, /label="Dark mode"/);
});
