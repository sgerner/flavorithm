import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type Rgb = [number, number, number];

const ROOT = process.cwd();
const APP_CSS_PATH = path.join(ROOT, 'src/app.css');
const PAGE_SVELTE_PATH = path.join(ROOT, 'src/routes/+page.svelte');
const SKELETON_THEMES_DIR = path.join(ROOT, 'node_modules/@skeletonlabs/skeleton/src/themes');

function oklchToLinearRgb(L: number, C: number, h: number): Rgb {
	const rad = (h * Math.PI) / 180;
	const a = C * Math.cos(rad);
	const b = C * Math.sin(rad);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	];
}

function inSrgbGamut(L: number, C: number, h: number): boolean {
	const [r, g, b] = oklchToLinearRgb(L, C, h);
	return r >= -0.001 && r <= 1.001 && g >= -0.001 && g <= 1.001 && b >= -0.001 && b <= 1.001;
}

function oklchToSrgb(L: number, C: number, h: number): Rgb {
	let chroma = Math.max(0, C);
	if (chroma > 0 && !inSrgbGamut(L, chroma, h)) {
		let lo = 0;
		let hi = chroma;
		for (let i = 0; i < 24; i++) {
			const mid = (lo + hi) / 2;
			if (inSrgbGamut(L, mid, h)) lo = mid;
			else hi = mid;
		}
		chroma = lo;
	}
	const [r, g, b] = oklchToLinearRgb(L, chroma, h);
	const toSrgb = (v: number): number => {
		const clamped = Math.max(0, Math.min(1, v));
		return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
	};
	return [toSrgb(r), toSrgb(g), toSrgb(b)];
}

function splitTopLevelComma(input: string): [string, string] {
	let depth = 0;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			return [input.slice(0, i).trim(), input.slice(i + 1).trim()];
		}
	}
	throw new Error(`Invalid light-dark() arguments: ${input}`);
}

function resolveColor(expr: string, vars: Record<string, string>, dark: boolean): Rgb {
	const value = expr.trim();
	if (value.startsWith('light-dark(') && value.endsWith(')')) {
		const [lightExpr, darkExpr] = splitTopLevelComma(value.slice(11, -1));
		return resolveColor(dark ? darkExpr : lightExpr, vars, dark);
	}
	if (value.startsWith('var(') && value.endsWith(')')) {
		const name = value.slice(4, -1).trim();
		const target = vars[name];
		assert.ok(target, `Missing CSS variable ${name}`);
		return resolveColor(target, vars, dark);
	}
	if (value.startsWith('#')) {
		let hex = value.slice(1);
		if (hex.length === 3 || hex.length === 4) {
			hex = hex
				.slice(0, 3)
				.split('')
				.map((ch) => ch + ch)
				.join('');
		} else if (hex.length === 8) {
			hex = hex.slice(0, 6);
		}
		assert.equal(hex.length, 6, `Unsupported hex color ${value}`);
		return [
			parseInt(hex.slice(0, 2), 16) / 255,
			parseInt(hex.slice(2, 4), 16) / 255,
			parseInt(hex.slice(4, 6), 16) / 255
		];
	}
	if (value.startsWith('oklch(') && value.endsWith(')')) {
		const parts = value
			.slice(6, -1)
			.trim()
			.split(' ')
			.map((part) => part.trim())
			.filter(Boolean);
		if (parts.length === 3) {
			const [rawL, rawC, rawH] = parts;
			const L = rawL.endsWith('%') ? parseFloat(rawL.slice(0, -1)) / 100 : parseFloat(rawL);
			const C = parseFloat(rawC);
			const h = rawH === 'none' ? 0 : parseFloat(rawH.endsWith('deg') ? rawH.slice(0, -3) : rawH);
			if (!Number.isNaN(L) && !Number.isNaN(C) && !Number.isNaN(h)) {
				return oklchToSrgb(L, C, h);
			}
		}
	}
	throw new Error(`Unsupported color expression: ${value}`);
}

function relativeLuminance([r, g, b]: Rgb): number {
	const channel = (c: number): number => {
		const quantized = Math.round(Math.max(0, Math.min(1, c)) * 255) / 255;
		return quantized <= 0.04045 ? quantized / 12.92 : Math.pow((quantized + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
	const l1 = relativeLuminance(fg);
	const l2 = relativeLuminance(bg);
	return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function applyBrightness([r, g, b]: Rgb, factor: number): Rgb {
	return [Math.min(1, r * factor), Math.min(1, g * factor), Math.min(1, b * factor)];
}

function parseDeclarations(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawDecl of block.split(';')) {
		const colonIdx = rawDecl.indexOf(':');
		if (colonIdx === -1) continue;
		const prop = rawDecl.slice(0, colonIdx).trim();
		if (!prop.startsWith('--')) continue;
		const val = rawDecl.slice(colonIdx + 1).trim();
		if (val) out[prop] = val;
	}
	return out;
}

function stripCssComments(css: string): string {
	let out = '';
	let pos = 0;
	while (pos < css.length) {
		const start = css.indexOf('/*', pos);
		if (start === -1) {
			out += css.slice(pos);
			break;
		}
		out += css.slice(pos, start);
		const end = css.indexOf('*/', start + 2);
		if (end === -1) break;
		pos = end + 2;
	}
	return out;
}

function extractTopLevelRuleBlocks(
	css: string
): Array<{ selector: string; body: string; media?: string }> {
	const stripped = stripCssComments(css);
	const rules: Array<{ selector: string; body: string; media?: string }> = [];

	function walk(source: string, media?: string) {
		let i = 0;
		while (i < source.length) {
			while (i < source.length && source.charCodeAt(i) <= 32) i++;
			if (i >= source.length) break;
			const openIdx = source.indexOf('{', i);
			const semiIdx = source.indexOf(';', i);
			if (semiIdx !== -1 && (openIdx === -1 || semiIdx < openIdx)) {
				i = semiIdx + 1;
				continue;
			}
			if (openIdx === -1) break;
			const prelude = source.slice(i, openIdx).trim();
			let depth = 1;
			let j = openIdx + 1;
			while (j < source.length && depth > 0) {
				if (source[j] === '{') depth++;
				else if (source[j] === '}') depth--;
				j++;
			}
			const body = source.slice(openIdx + 1, j - 1);
			if (prelude.startsWith('@media')) {
				walk(body, prelude);
			} else if (!prelude.startsWith('@keyframes')) {
				rules.push({ selector: prelude, body, media });
			}
			i = j;
		}
	}

	walk(stripped);
	return rules;
}

function loadSelectableThemes(): string[] {
	const svelte = fs.readFileSync(PAGE_SVELTE_PATH, 'utf8');
	const marker = 'const themes = [';
	const start = svelte.indexOf(marker);
	assert.notEqual(start, -1, 'Could not locate const themes in src/routes/+page.svelte');
	const end = svelte.indexOf('];', start + marker.length);
	assert.notEqual(end, -1, 'Could not locate closing ]; for const themes');
	const listBody = svelte.slice(start + marker.length, end);
	const themes: string[] = [];
	for (const item of listBody.split(',')) {
		const trimmed = item.trim();
		if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 2) {
			themes.push(trimmed.slice(1, -1));
		}
	}
	return themes;
}

function isCssIdentChar(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 45 ||
		code === 95
	);
}

function normalizeSelectorForSpecificity(selector: string): string {
	const stack: Array<'where' | 'not' | 'other'> = [];
	let whereDepth = 0;
	let out = '';
	let i = 0;
	while (i < selector.length) {
		if (selector.startsWith(':where(', i)) {
			stack.push('where');
			whereDepth++;
			i += 7;
			continue;
		}
		if (selector.startsWith(':not(', i)) {
			stack.push('not');
			i += 5;
			continue;
		}
		const ch = selector[i];
		if (ch === '(') {
			stack.push('other');
			if (whereDepth === 0) out += ch;
			i++;
			continue;
		}
		if (ch === ')') {
			const kind = stack.pop();
			if (kind === 'where') whereDepth--;
			else if (kind === 'other' && whereDepth === 0) out += ch;
			i++;
			continue;
		}
		if (whereDepth === 0) out += ch;
		i++;
	}
	return out;
}

function selectorSpecificity(selector: string): number {
	const normalized = normalizeSelectorForSpecificity(selector);
	let ids = 0;
	let attrsAndPseudos = 0;
	let elements = 0;
	let i = 0;
	while (i < normalized.length) {
		const ch = normalized[i];
		if (ch === '[') {
			const closeIdx = normalized.indexOf(']', i + 1);
			if (closeIdx === -1) break;
			if (closeIdx > i + 1) attrsAndPseudos++;
			i = closeIdx + 1;
			continue;
		}
		if (ch === '#') {
			i++;
			const start = i;
			while (i < normalized.length && isCssIdentChar(normalized[i])) i++;
			if (i > start) ids++;
			continue;
		}
		if (ch === '.') {
			i++;
			const start = i;
			while (i < normalized.length && isCssIdentChar(normalized[i])) i++;
			if (i > start) attrsAndPseudos++;
			continue;
		}
		if (ch === ':') {
			if (normalized[i + 1] === ':') {
				i += 2;
				const start = i;
				while (i < normalized.length && isCssIdentChar(normalized[i])) i++;
				if (i > start) elements++;
			} else {
				i++;
				const start = i;
				while (i < normalized.length && isCssIdentChar(normalized[i])) i++;
				if (i > start) attrsAndPseudos++;
			}
			continue;
		}
		if (isCssIdentChar(ch)) {
			while (i < normalized.length && isCssIdentChar(normalized[i])) i++;
			elements++;
			continue;
		}
		i++;
	}
	return ids * 10000 + attrsAndPseudos * 100 + elements;
}

function buildThemeVariables(
	appRules: Array<{ selector: string; body: string; media?: string }>,
	theme: string,
	prefersContrastMore = false
): Record<string, string> {
	const skeletonCss = fs.readFileSync(path.join(SKELETON_THEMES_DIR, `${theme}.css`), 'utf8');
	const matched: Array<{ spec: number; order: number; decls: Record<string, string> }> = [
		{ spec: 100, order: 0, decls: parseDeclarations(skeletonCss) }
	];
	let order = 1;
	for (const rule of appRules) {
		if (rule.media) {
			if (!prefersContrastMore || !rule.media.includes('prefers-contrast: more')) continue;
		}
		const selectors = rule.selector.split(',').map((s) => s.trim());
		for (const sel of selectors) {
			if (
				sel === ':root' ||
				sel === 'html[data-theme]' ||
				((sel === "html[data-theme]:not([data-theme='nosh'])" ||
					sel === "html[data-theme]:where(:not([data-theme='nosh']))") &&
					theme !== 'nosh') ||
				sel === `html[data-theme='${theme}']`
			) {
				matched.push({
					spec: selectorSpecificity(sel),
					order: order++,
					decls: parseDeclarations(rule.body)
				});
			}
		}
	}
	matched.sort((a, b) => a.spec - b.spec || a.order - b.order);
	const vars: Record<string, string> = {};
	for (const item of matched) {
		Object.assign(vars, item.decls);
	}
	return vars;
}

test('all 24 selectable themes are imported once and calibrated across all 48 light/dark modes', () => {
	const appCss = fs.readFileSync(APP_CSS_PATH, 'utf8');
	const themes = loadSelectableThemes();
	assert.equal(themes.length, 24);

	for (const theme of themes) {
		assert.ok(
			appCss.includes(`@import '@skeletonlabs/skeleton/themes/${theme}';`),
			`Missing Skeleton theme import for ${theme}`
		);
	}

	const appRules = extractTopLevelRuleBlocks(appCss);
	const nonNoshBlocks = appRules.filter(
		(rule) => !rule.media && rule.selector === "html[data-theme]:where(:not([data-theme='nosh']))"
	);
	assert.equal(nonNoshBlocks.length, 1, 'Duplicate non-nosh theme blocks must stay consolidated');

	const failures: string[] = [];
	for (const theme of themes) {
		for (const dark of [false, true]) {
			const mode = `${theme}:${dark ? 'dark' : 'light'}`;
			const vars = buildThemeVariables(appRules, theme, false);

			const paper = resolveColor('var(--paper)', vars, dark);
			const surface = resolveColor('var(--surface)', vars, dark);
			const sidebar = resolveColor('var(--sidebar)', vars, dark);
			const wash = resolveColor('var(--wash)', vars, dark);
			const ink = resolveColor('var(--ink)', vars, dark);
			const muted = resolveColor('var(--muted)', vars, dark);
			const green = resolveColor('var(--green)', vars, dark);
			const onGreen = resolveColor('var(--on-green)', vars, dark);
			const accent = resolveColor('var(--accent)', vars, dark);
			const onAccent = resolveColor('var(--on-accent)', vars, dark);
			const warningSurface = resolveColor('var(--warning-surface)', vars, dark);
			const warningInk = resolveColor('var(--warning-ink)', vars, dark);
			const dangerSurface = resolveColor('var(--danger-surface)', vars, dark);
			const dangerInk = resolveColor('var(--danger-ink)', vars, dark);
			const dangerFill = resolveColor('var(--danger-fill)', vars, dark);
			const dangerFillHover = resolveColor('var(--danger-fill-hover)', vars, dark);
			const onDangerFill = resolveColor('var(--on-danger-fill)', vars, dark);

			const surfaces: Array<[string, Rgb]> = [
				['--paper', paper],
				['--surface', surface],
				['--sidebar', sidebar],
				['--wash', wash]
			];

			for (const [surfaceName, bg] of surfaces) {
				const inkRatio = contrastRatio(ink, bg);
				if (inkRatio < 4.5)
					failures.push(`${mode} --ink on ${surfaceName} = ${inkRatio.toFixed(2)}`);

				const mutedRatio = contrastRatio(muted, bg);
				if (mutedRatio < 4.5)
					failures.push(`${mode} --muted on ${surfaceName} = ${mutedRatio.toFixed(2)}`);

				const greenRatio = contrastRatio(green, bg);
				if (greenRatio < 4.5)
					failures.push(`${mode} --green text/chip on ${surfaceName} = ${greenRatio.toFixed(2)}`);
				if (greenRatio < 3)
					failures.push(
						`${mode} --green focus outline on ${surfaceName} = ${greenRatio.toFixed(2)}`
					);

				const dangerTextRatio = contrastRatio(dangerInk, bg);
				if (dangerTextRatio < 4.5)
					failures.push(`${mode} --danger-ink on ${surfaceName} = ${dangerTextRatio.toFixed(2)}`);
			}

			const primaryRatio = contrastRatio(onGreen, green);
			if (primaryRatio < 4.5)
				failures.push(`${mode} --on-green on --green = ${primaryRatio.toFixed(2)}`);

			const hoveredPrimaryRatio = contrastRatio(
				applyBrightness(onGreen, 1.08),
				applyBrightness(green, 1.08)
			);
			if (hoveredPrimaryRatio < 4.5)
				failures.push(
					`${mode} hovered .primary (brightness 1.08) = ${hoveredPrimaryRatio.toFixed(2)}`
				);

			const ownerBadgeRatio = contrastRatio(onAccent, accent);
			if (ownerBadgeRatio < 4.5)
				failures.push(`${mode} .owner-role (--on-accent/--accent) = ${ownerBadgeRatio.toFixed(2)}`);

			const warningBadgeRatio = contrastRatio(warningInk, warningSurface);
			if (warningBadgeRatio < 4.5)
				failures.push(`${mode} .expiry-badge.soon = ${warningBadgeRatio.toFixed(2)}`);

			const expiredBadgeRatio = contrastRatio(dangerInk, dangerSurface);
			if (expiredBadgeRatio < 4.5)
				failures.push(`${mode} .expiry-badge.expired / .error = ${expiredBadgeRatio.toFixed(2)}`);

			for (const [label, fill] of [
				['--danger-fill', dangerFill],
				['--danger-fill-hover', dangerFillHover],
				['--danger-fill brightness(1.08)', applyBrightness(dangerFill, 1.08)]
			] as Array<[string, Rgb]>) {
				const ratio = contrastRatio(onDangerFill, fill);
				if (ratio < 4.5) failures.push(`${mode} ${label} = ${ratio.toFixed(2)}`);
			}

			// Enhanced contrast requirement (WCAG 1.4.6): muted text >= 7:1 under prefers-contrast: more
			const moreVars = buildThemeVariables(appRules, theme, true);
			const enhancedMuted = resolveColor('var(--muted)', moreVars, dark);
			for (const [surfaceName, bg] of surfaces) {
				const enhancedRatio = contrastRatio(enhancedMuted, bg);
				if (enhancedRatio < 7) {
					failures.push(
						`${mode} prefers-contrast:more --muted on ${surfaceName} = ${enhancedRatio.toFixed(2)}`
					);
				}
			}
		}
	}

	assert.deepEqual(failures, []);
});

test('zero custom foreground declarations lack a paired or theme-verified background token (Failure F24)', () => {
	const allowedVerifiedColorValues = new Set([
		'inherit',
		'currentColor',
		'var(--ink)',
		'var(--muted)',
		'var(--green)',
		'var(--on-green)',
		'var(--on-accent)',
		'var(--warning-ink)',
		'var(--danger-ink)',
		'var(--on-danger-fill)',
		'var(--paper)',
		'var(--surface)',
		'HighlightText'
	]);

	function collectStyleFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...collectStyleFiles(full));
			else if (entry.name.endsWith('.css') || entry.name.endsWith('.svelte')) out.push(full);
		}
		return out;
	}

	function extractSvelteStyleBlocks(svelte: string): string[] {
		const blocks: string[] = [];
		let pos = 0;
		while (pos < svelte.length) {
			const openStart = svelte.indexOf('<style', pos);
			if (openStart === -1) break;
			const openEnd = svelte.indexOf('>', openStart + 6);
			if (openEnd === -1) break;
			const closeStart = svelte.indexOf('</style>', openEnd + 1);
			if (closeStart === -1) break;
			blocks.push(svelte.slice(openEnd + 1, closeStart));
			pos = closeStart + 8;
		}
		return blocks;
	}

	function extractStyleProperties(body: string): Array<{ prop: string; value: string }> {
		const props: Array<{ prop: string; value: string }> = [];
		for (const rawDecl of stripCssComments(body).split(';')) {
			const colonIdx = rawDecl.indexOf(':');
			if (colonIdx === -1) continue;
			const prop = rawDecl.slice(0, colonIdx).trim();
			const value = rawDecl.slice(colonIdx + 1).trim();
			if (prop && value) props.push({ prop, value });
		}
		return props;
	}

	const unpaired: string[] = [];
	for (const file of collectStyleFiles(path.join(ROOT, 'src'))) {
		const rel = path.relative(ROOT, file);
		const content = fs.readFileSync(file, 'utf8');
		const cssBlocks = file.endsWith('.css') ? [content] : extractSvelteStyleBlocks(content);

		for (const css of cssBlocks) {
			for (const rule of extractTopLevelRuleBlocks(css)) {
				const props = extractStyleProperties(rule.body);
				const colorValues = props.filter((p) => p.prop === 'color').map((p) => p.value);
				if (!colorValues.length) continue;
				const bgProp = props.find((p) => p.prop === 'background' || p.prop === 'background-color');

				for (const fg of colorValues) {
					if (allowedVerifiedColorValues.has(fg)) continue;

					// Allow fixed editorial containers (e.g. .inspiration-banner children) or rules that explicitly pair background + color
					if (bgProp) {
						const bg = bgProp.value;
						if (fg.startsWith('#') && bg.startsWith('#')) {
							const ratio = contrastRatio(resolveColor(fg, {}, false), resolveColor(bg, {}, false));
							if (ratio < 4.5) {
								unpaired.push(
									`${rel} (${rule.selector}): paired ${fg} on ${bg} = ${ratio.toFixed(2)}`
								);
							}
							continue;
						}
					}

					if (rule.selector.startsWith('.banner-')) {
						// Explicitly scoped inside .inspiration-banner (background: #294b37)
						const ratio = contrastRatio(
							resolveColor(fg, {}, false),
							resolveColor('#294b37', {}, false)
						);
						if (ratio < 4.5) {
							unpaired.push(
								`${rel} (${rule.selector}): banner child ${fg} on #294b37 = ${ratio.toFixed(2)}`
							);
						}
						continue;
					}

					if (rule.selector === '.visual-spark') continue;

					unpaired.push(`${rel} (${rule.selector}): unpaired foreground color: ${fg}`);
				}
			}
		}
	}

	assert.deepEqual(unpaired, []);

	const appCss = fs.readFileSync(APP_CSS_PATH, 'utf8');
	assert.ok(appCss.includes('@media (forced-colors: active)'));
	assert.ok(appCss.includes('@media (prefers-contrast: more)'));
});

test('selectorSpecificity evaluates :where() and :not() in linear time without backtracking', () => {
	assert.equal(selectorSpecificity(':root'), 100);
	assert.equal(selectorSpecificity('html[data-theme]'), 101);
	assert.equal(selectorSpecificity("html[data-theme='nosh']"), 101);
	assert.equal(selectorSpecificity("html[data-theme]:where(:not([data-theme='nosh']))"), 101);
	assert.equal(selectorSpecificity("html[data-theme]:not([data-theme='nosh'])"), 201);

	const start = performance.now();
	assert.equal(selectorSpecificity('html:where(' + "'".repeat(50_000)), 1);
	assert.equal(selectorSpecificity('html' + ':where('.repeat(10_000)), 1);
	assert.ok(performance.now() - start < 200);
});
