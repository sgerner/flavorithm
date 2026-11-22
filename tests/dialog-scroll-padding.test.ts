import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

interface CssRule {
	media: string | null;
	selector: string;
	declarations: Map<string, string>;
}

function parseCssRules(source: string): CssRule[] {
	const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '');
	const rules: CssRule[] = [];
	const parseBlock = (block: string, media: string | null) => {
		let index = 0;
		while (index < block.length) {
			while (index < block.length && /\s/.test(block[index])) index += 1;
			if (index >= block.length) break;

			const openBrace = block.indexOf('{', index);
			const semicolon = block.indexOf(';', index);
			if (semicolon !== -1 && (openBrace === -1 || semicolon < openBrace)) {
				index = semicolon + 1;
				continue;
			}
			if (openBrace === -1) break;

			const header = block.slice(index, openBrace).trim();
			let depth = 1;
			let cursor = openBrace + 1;
			while (cursor < block.length && depth > 0) {
				if (block[cursor] === '{') depth += 1;
				else if (block[cursor] === '}') depth -= 1;
				cursor += 1;
			}
			const body = block.slice(openBrace + 1, cursor - 1);

			if (header.startsWith('@media')) {
				parseBlock(body, header.replace(/\s+/g, ' '));
			} else if (!header.startsWith('@')) {
				const declarations = new Map<string, string>();
				for (const entry of body.split(';')) {
					const colon = entry.indexOf(':');
					if (colon === -1) continue;
					const prop = entry.slice(0, colon).trim();
					const value = entry
						.slice(colon + 1)
						.trim()
						.replace(/\s+/g, ' ');
					if (prop) declarations.set(prop, value);
				}
				rules.push({
					media,
					selector: header.replace(/\s+/g, ' '),
					declarations
				});
			}
			index = cursor;
		}
	};
	parseBlock(cleaned, null);
	return rules;
}

function pxFromDeclaration(value: string | undefined, pattern: RegExp): number {
	assert.ok(value, `Expected declaration matching ${pattern}`);
	const match = value.match(pattern);
	assert.ok(match, `Could not parse px value from "${value}" with ${pattern}`);
	return Number(match[1]);
}

test('shared and mobile .flavor-dialog rules reserve scroll-padding-bottom above sticky .draft-footer', () => {
	const css = readFileSync('src/app.css', 'utf8');
	const rules = parseCssRules(css);
	const expectedScrollPadding = 'calc(5.5rem + env(safe-area-inset-bottom))';

	const baseDialog = rules.find(
		(rule) =>
			rule.media === null && rule.selector === '.flavor-dialog' && rule.declarations.has('overflow')
	);
	assert.ok(baseDialog, 'Expected scrollable base .flavor-dialog rule');
	assert.equal(baseDialog.declarations.get('overflow'), 'auto');
	assert.equal(baseDialog.declarations.get('scroll-padding-bottom'), expectedScrollPadding);

	const captureDialog = rules.find(
		(rule) => rule.media === null && rule.selector === '.flavor-dialog.capture-dialog'
	);
	assert.ok(captureDialog, 'Expected .flavor-dialog.capture-dialog rule');
	assert.equal(captureDialog.declarations.get('scroll-padding-bottom'), expectedScrollPadding);

	const mobileDialog = rules.find(
		(rule) =>
			rule.media === '@media (max-width: 650px)' &&
			rule.selector.split(',').some((part) => part.trim() === '.flavor-dialog') &&
			rule.declarations.has('overscroll-behavior')
	);
	assert.ok(mobileDialog, 'Expected mobile @media (max-width: 650px) .flavor-dialog rule');
	assert.equal(mobileDialog.declarations.get('scroll-padding-bottom'), expectedScrollPadding);

	for (const rule of rules) {
		if (!rule.selector.includes('.flavor-dialog')) continue;
		if (rule.declarations.has('scroll-padding')) {
			assert.fail(`Unexpected scroll-padding shorthand override on "${rule.selector}"`);
		}
		if (rule.declarations.has('scroll-padding-bottom')) {
			assert.equal(
				rule.declarations.get('scroll-padding-bottom'),
				expectedScrollPadding,
				`Expected consistent scroll-padding-bottom on "${rule.selector}"`
			);
		}
	}

	const desktopFooter = rules.find(
		(rule) => rule.media === null && rule.selector === '.draft-footer'
	);
	const desktopFooterButtons = rules.find(
		(rule) => rule.media === null && rule.selector === '.draft-footer > button'
	);
	const mobileFooter = rules.find(
		(rule) => rule.media === '@media (max-width: 650px)' && rule.selector === '.draft-footer'
	);
	const mobileFooterButtons = rules.find(
		(rule) =>
			rule.media === '@media (max-width: 650px)' && rule.selector === '.draft-footer > button'
	);
	const focusVisibleButton = rules.find(
		(rule) => rule.media === null && rule.selector.includes('button:focus-visible')
	);

	assert.ok(desktopFooter && desktopFooterButtons, 'Expected desktop .draft-footer rules');
	assert.ok(mobileFooter && mobileFooterButtons, 'Expected mobile .draft-footer rules');
	assert.ok(focusVisibleButton, 'Expected button:focus-visible outline rule');

	assert.equal(desktopFooter.declarations.get('position'), 'sticky');
	assert.match(desktopFooter.declarations.get('padding') ?? '', /env\(safe-area-inset-bottom\)/);
	assert.match(mobileFooter.declarations.get('padding') ?? '', /env\(safe-area-inset-bottom\)/);

	const borderTopPx = pxFromDeclaration(desktopFooter.declarations.get('border-top'), /^(\d+)px\b/);
	const desktopPaddingMatch = (desktopFooter.declarations.get('padding') ?? '').match(
		/^(\d+)px\s+\d+px\s+max\((\d+)px,\s*env\(safe-area-inset-bottom\)\)$/
	);
	assert.ok(desktopPaddingMatch, 'Expected desktop .draft-footer padding with safe-area fallback');
	const desktopButtonHeight = pxFromDeclaration(
		desktopFooterButtons.declarations.get('min-height'),
		/^(\d+)px$/
	);
	const desktopFooterHeight =
		borderTopPx +
		Number(desktopPaddingMatch[1]) +
		desktopButtonHeight +
		Number(desktopPaddingMatch[2]);

	const mobilePaddingMatch = (mobileFooter.declarations.get('padding') ?? '').match(
		/^(\d+)px\s+\d+px\s+max\((\d+)px,\s*env\(safe-area-inset-bottom\)\)$/
	);
	assert.ok(mobilePaddingMatch, 'Expected mobile .draft-footer padding with safe-area fallback');
	const mobileButtonHeight = pxFromDeclaration(
		mobileFooterButtons.declarations.get('min-height'),
		/^(\d+)px$/
	);
	const mobileFooterHeight =
		borderTopPx +
		Number(mobilePaddingMatch[1]) +
		mobileButtonHeight +
		Number(mobilePaddingMatch[2]);

	const outlineWidth = pxFromDeclaration(
		focusVisibleButton.declarations.get('outline'),
		/^(\d+)px\b/
	);
	const outlineOffset = pxFromDeclaration(
		focusVisibleButton.declarations.get('outline-offset'),
		/^(\d+)px$/
	);
	const focusRingOutset = outlineWidth + outlineOffset;

	const clearanceRemMatch = expectedScrollPadding.match(/^calc\(([\d.]+)rem\b/);
	assert.ok(clearanceRemMatch);
	const clearancePxAt16 = Number(clearanceRemMatch[1]) * 16;

	assert.ok(
		clearancePxAt16 >= desktopFooterHeight + focusRingOutset,
		`Expected ${clearancePxAt16}px clearance >= desktop footer (${desktopFooterHeight}px) + focus ring (${focusRingOutset}px)`
	);
	assert.ok(
		clearancePxAt16 >= mobileFooterHeight + focusRingOutset,
		`Expected ${clearancePxAt16}px clearance >= mobile footer (${mobileFooterHeight}px) + focus ring (${focusRingOutset}px)`
	);
});
