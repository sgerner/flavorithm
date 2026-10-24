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
