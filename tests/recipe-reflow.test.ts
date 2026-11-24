import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'svelte/compiler';

type CssRule = {
	media: string | null;
	selector: string;
	body: string;
};

function extractCssRules(css: string): CssRule[] {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const rules: CssRule[] = [];
	let index = 0;

	const parseBlock = (source: string, media: string | null) => {
		let cursor = 0;
		while (cursor < source.length) {
			const open = source.indexOf('{', cursor);
			if (open === -1) break;
			const prelude = source.slice(cursor, open).trim();
			let depth = 1;
			let pos = open + 1;
			while (pos < source.length && depth > 0) {
				if (source[pos] === '{') depth += 1;
				else if (source[pos] === '}') depth -= 1;
				pos += 1;
			}
			const inner = source.slice(open + 1, pos - 1);
			if (prelude.startsWith('@media')) {
				parseBlock(inner, prelude);
			} else if (!prelude.startsWith('@')) {
				for (const selector of prelude.split(',').map((part) => part.trim())) {
					if (selector) rules.push({ media, selector, body: inner });
				}
			}
			cursor = pos;
		}
	};

	parseBlock(stripped.slice(index), null);
	return rules;
}

const appCss = readFileSync('src/app.css', 'utf8');
const pageSource = readFileSync('src/routes/+page.svelte', 'utf8');
const detailSource = readFileSync('src/lib/components/RecipeDetail.svelte', 'utf8');

test('responsive CSS keeps recipe badges and section headings visible while reflowing below 650px', () => {
	const rules = extractCssRules(appCss);

	const hiddenBadges = rules.filter(
		(rule) => rule.selector.includes('.recipe-badge') && /display\s*:\s*none\b/.test(rule.body)
	);
	assert.deepEqual(hiddenBadges, []);

	const hiddenSectionHeadings = rules.filter(
		(rule) =>
			rule.selector.includes('.section-heading') &&
			!rule.selector.includes('.small-spark') &&
			/display\s*:\s*none\b/.test(rule.body)
	);
	assert.deepEqual(hiddenSectionHeadings, []);

	const baseCard = rules.find((rule) => rule.media === null && rule.selector === '.recipe-card');
	assert.ok(baseCard);
	assert.match(baseCard.body, /position\s*:\s*relative\b/);

	const baseTags = rules.find((rule) => rule.media === null && rule.selector === '.recipe-tags');
	assert.ok(baseTags);
	assert.match(baseTags.body, /display\s*:\s*flex\b/);
	assert.match(baseTags.body, /flex-wrap\s*:\s*wrap\b/);

	const baseBadge = rules.find((rule) => rule.media === null && rule.selector === '.recipe-badge');
	assert.ok(baseBadge);
	assert.match(baseBadge.body, /min-width\s*:\s*0\b/);
	assert.match(baseBadge.body, /overflow-wrap\s*:\s*anywhere\b/);

	const mobileRules = rules.filter(
		(rule) => rule.media !== null && rule.media.includes('max-width: 650px')
	);
	assert.ok(
		mobileRules.some(
			(rule) =>
				rule.selector === '.recipe-card .recipe-tags' && /position\s*:\s*static\b/.test(rule.body)
		)
	);
	assert.ok(
		mobileRules.some(
			(rule) =>
				rule.selector === '.recipe-badge' &&
				/white-space\s*:\s*normal\b/.test(rule.body) &&
				!/text-overflow\s*:\s*ellipsis\b/.test(rule.body)
		)
	);
	assert.ok(
		mobileRules.some(
			(rule) =>
				rule.selector === '.recipe-section .section-heading' &&
				/flex-direction\s*:\s*column\b/.test(rule.body)
		)
	);
});

test('Discover and Saved cards expose clean h2 headings and reflowed tag chips inside .recipe-info', () => {
	const ast = parse(pageSource, { modern: true });
	assert.ok(ast.fragment);

	const headingMatch = pageSource.match(
		/<div class="section-heading">([\s\S]*?)<div class="recipe-toolbar">/
	);
	assert.ok(headingMatch);
	assert.match(headingMatch[1], /<h2>[\s\S]*?<span[^>]*class="small-spark"[^>]*aria-hidden="true"/);

	const cardMatch = pageSource.match(/<article\s+class="recipe-card"([\s\S]*?)<\/article>/);
	assert.ok(cardMatch);
	const cardMarkup = cardMatch[1];

	const imageBlock = cardMarkup.match(/<div class="recipe-image">([\s\S]*?)<\/div>/);
	assert.ok(imageBlock);
	assert.doesNotMatch(imageBlock[1], /recipe-badge|recipe-tags/);

	const infoIndex = cardMarkup.indexOf('<div class="recipe-info">');
	const tagsIndex = cardMarkup.indexOf('<ul class="recipe-tags">');
	const metaIndex = cardMarkup.indexOf('<div class="recipe-meta">');
	assert.ok(infoIndex !== -1 && tagsIndex > infoIndex && metaIndex > tagsIndex);

	assert.match(
		cardMarkup,
		/\{#if recipe\.hidden \|\| recipe\.tags\.length\}<ul class="recipe-tags">[\s\S]*?\{#if recipe\.hidden\}<li class="recipe-badge">Hidden<\/li>\{\/if\}[\s\S]*?\{#each recipe\.tags as tag\}<li class="recipe-badge">\{tag\}<\/li>\{\/each\}[\s\S]*?<\/ul>\{\/if\}/
	);
});

test('RecipeDetail renders Hidden visibility badge and dietary recipe.tags beside .detail-meta', () => {
	const ast = parse(detailSource, { modern: true });
	assert.ok(ast.fragment);

	const bodyMatch = detailSource.match(/<div class="detail-body">([\s\S]*?)<div class="tabs"[\s>]/);
	assert.ok(bodyMatch);
	const bodyMarkup = bodyMatch[1];

	const metaIndex = bodyMarkup.indexOf('<div class="detail-meta">');
	const tagsIndex = bodyMarkup.indexOf('<ul class="recipe-tags">');
	const actionsIndex = bodyMarkup.indexOf('<div class="detail-actions">');
	assert.ok(metaIndex !== -1 && tagsIndex > metaIndex && actionsIndex > tagsIndex);

	assert.match(
		bodyMarkup,
		/\{#if recipe\.hidden \|\| recipe\.tags\.length\}<ul class="recipe-tags">[\s\S]*?\{#if recipe\.hidden\}<li class="recipe-badge">Hidden<\/li>\{\/if\}[\s\S]*?\{#each recipe\.tags as tag\}<li class="recipe-badge">\{tag\}<\/li>\{\/each\}[\s\S]*?<\/ul>\{\/if\}/
	);
});
