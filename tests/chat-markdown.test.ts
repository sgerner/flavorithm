import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatMarkdown, safeMarkdownHref } from '../src/lib/chat-markdown.ts';

test('raw HTML remains literal text and unsafe link destinations are not clickable', () => {
	const blocks = parseChatMarkdown(
		'<script>alert(1)</script>\n\n[click](javascript:alert(1)) [also](data:text/html,x)'
	);
	assert.deepEqual(blocks[0], { type: 'text-block', text: '<script>alert(1)</script>' });
	assert.equal(blocks[1]?.type, 'paragraph');
	if (blocks[1]?.type !== 'paragraph') assert.fail('expected paragraph');
	assert.deepEqual(blocks[1].children, [
		{ type: 'text', text: 'click' },
		{ type: 'text', text: ' ' },
		{ type: 'text', text: 'also' }
	]);
	assert.equal(safeMarkdownHref('//evil.example/path'), undefined);
	assert.equal(safeMarkdownHref('\\\\evil.example'), undefined);
});

test('allows only safe link protocols and local root/hash destinations', () => {
	assert.equal(safeMarkdownHref('https://example.com/a'), 'https://example.com/a');
	assert.equal(safeMarkdownHref('MAILTO:test@example.com'), 'MAILTO:test@example.com');
	assert.equal(safeMarkdownHref('/recipes/pasta'), '/recipes/pasta');
	assert.equal(safeMarkdownHref('#details'), '#details');
	assert.equal(safeMarkdownHref('javascript:alert(1)'), undefined);
	assert.equal(safeMarkdownHref('data:image/svg+xml,x'), undefined);
	assert.equal(safeMarkdownHref('relative/path'), undefined);
	assert.equal(safeMarkdownHref('/\t/evil.example'), undefined);
	assert.equal(safeMarkdownHref('java\nscript:alert(1)'), undefined);
	assert.equal(safeMarkdownHref('https://example.com/\u0000path'), undefined);
});

test('parses common GFM blocks and inline formatting into semantic nodes', () => {
	const blocks = parseChatMarkdown(
		[
			'# Dinner',
			'',
			'**Bold**, *italic*, ~~removed~~, `code`, and [recipe](/recipes/1).',
			'',
			'- one',
			'- two',
			'',
			'> Keep it simple.',
			'',
			'| Food | Count |',
			'| --- | ---: |',
			'| pasta | 2 |',
			'',
			'```txt',
			'<b>literal</b>',
			'```'
		].join('\n')
	);
	assert.equal(blocks[0]?.type, 'heading');
	assert.equal(blocks[1]?.type, 'paragraph');
	if (blocks[1]?.type !== 'paragraph') assert.fail('expected paragraph');
	assert.deepEqual(
		blocks[1].children.map((node) => node.type),
		['strong', 'text', 'em', 'text', 'del', 'text', 'code', 'text', 'link', 'text']
	);
	assert.equal(blocks[2]?.type, 'list');
	assert.equal(blocks[3]?.type, 'quote');
	assert.equal(blocks[4]?.type, 'table');
	assert.deepEqual(blocks[5], { type: 'code', text: '<b>literal</b>' });
});

test('images are represented as alt text with a safe optional link, never an embed', () => {
	const blocks = parseChatMarkdown(
		'![remote photo](https://images.example/photo.jpg) and ![bad](javascript:alert(1))'
	);
	assert.equal(blocks[0]?.type, 'paragraph');
	if (blocks[0]?.type !== 'paragraph') assert.fail('expected paragraph');
	assert.deepEqual(
		blocks[0].children.filter((node) => node.type === 'image'),
		[
			{ type: 'image', alt: 'remote photo', href: 'https://images.example/photo.jpg' },
			{ type: 'image', alt: 'bad', href: undefined }
		]
	);
});

test('headings normalize into h3 through h6 under the chat dialog heading', () => {
	const fromH1 = parseChatMarkdown(
		'# Dinner\n\n## Sides\n\n### Sauce\n\n#### Garnish\n\n##### Extra'
	);
	assert.deepEqual(
		fromH1.map((node) => (node.type === 'heading' ? node.depth : null)),
		[3, 4, 5, 6, 6]
	);
	const fromH2 = parseChatMarkdown('## Tonight\n\n### Prep');
	assert.deepEqual(
		fromH2.map((node) => (node.type === 'heading' ? node.depth : null)),
		[3, 4]
	);
	const fromH3 = parseChatMarkdown('### Already nested\n\n#### Detail');
	assert.deepEqual(
		fromH3.map((node) => (node.type === 'heading' ? node.depth : null)),
		[3, 4]
	);
});

test('strips unlinked alt-less images and labels linked alt-less images by host without "Image"', () => {
	const blocks = parseChatMarkdown(
		[
			'![]() ![](javascript:alert(1)) ![   ](relative/path)',
			'',
			'![](https://www.seriouseats.com/pasta.jpg) and ![/local](/recipes/1) and ![mail](mailto:chef@example.com) and ![](mailto:chef@example.com) and ![](#steps)',
			'',
			'[![](https://cdn.example.org/hero.png)](https://recipes.example.org/soup)'
		].join('\n')
	);
	assert.equal(blocks[0]?.type, 'paragraph');
	if (blocks[0]?.type !== 'paragraph') assert.fail('expected first paragraph');
	assert.equal(
		blocks[0].children.some((node) => node.type === 'image'),
		false
	);

	assert.equal(blocks[1]?.type, 'paragraph');
	if (blocks[1]?.type !== 'paragraph') assert.fail('expected second paragraph');
	const images = blocks[1].children.filter((node) => node.type === 'image');
	assert.deepEqual(images, [
		{
			type: 'image',
			alt: 'Open media from seriouseats.com',
			href: 'https://www.seriouseats.com/pasta.jpg'
		},
		{ type: 'image', alt: '/local', href: '/recipes/1' },
		{ type: 'image', alt: 'mail', href: 'mailto:chef@example.com' },
		{ type: 'image', alt: 'Email link (example.com)', href: 'mailto:chef@example.com' },
		{ type: 'image', alt: 'Section link (steps)', href: '#steps' }
	]);
	for (const img of images) {
		assert.equal(img.alt.includes('Image'), false);
	}

	assert.equal(blocks[2]?.type, 'paragraph');
	if (blocks[2]?.type !== 'paragraph') assert.fail('expected third paragraph');
	assert.deepEqual(blocks[2].children, [
		{
			type: 'link',
			href: 'https://recipes.example.org/soup',
			children: [{ type: 'text', text: 'Open media from recipes.example.org' }]
		}
	]);
});

test('computes unique descriptive labels for markdown tables', () => {
	const blocks = parseChatMarkdown(
		[
			'## Pantry stock',
			'',
			'| Ingredient | Quantity |',
			'| --- | --- |',
			'| Flour | 500 g |',
			'',
			'| Ingredient | Quantity |',
			'| --- | --- |',
			'| Sugar | 200 g |',
			'',
			'## Shopping',
			'',
			'| Item | Aisle |',
			'| --- | --- |',
			'| Milk | Dairy |'
		].join('\n')
	);
	const tables = blocks.filter((node) => node.type === 'table');
	assert.equal(tables.length, 3);
	const labels = tables.map((table) => table.label);
	assert.equal(new Set(labels).size, 3);
	assert.deepEqual(labels, [
		'Pantry stock: Ingredient, Quantity table',
		'Pantry stock: Ingredient, Quantity table (2)',
		'Shopping: Item, Aisle table'
	]);
});

test('flags break-adjacent links as stacked while keeping inline prose links unflagged', () => {
	const blocks = parseChatMarkdown(
		[
			'Read [pasta guide](https://example.com/pasta) before cooking.',
			'',
			'[Monday dinner](https://example.com/mon)\n[Tuesday dinner](https://example.com/tue)\n[Wednesday dinner](https://example.com/wed)'
		].join('\n')
	);
	if (blocks[0]?.type !== 'paragraph' || blocks[1]?.type !== 'paragraph') {
		assert.fail('expected paragraphs');
	}
	const inlineLink = blocks[0].children.find((node) => node.type === 'link');
	assert.deepEqual(inlineLink, {
		type: 'link',
		href: 'https://example.com/pasta',
		children: [{ type: 'text', text: 'pasta guide' }]
	});
	const stackedLinks = blocks[1].children.filter((node) => node.type === 'link');
	assert.equal(stackedLinks.length, 3);
	for (const link of stackedLinks) {
		assert.equal(link.stacked, true);
	}
});
