import { marked, type Token } from 'marked';

export type InlineNode =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'break' }
	| { type: 'strong' | 'em' | 'del'; children: InlineNode[] }
	| { type: 'link'; href: string; children: InlineNode[]; stacked?: true }
	| { type: 'image'; alt: string; href?: string; stacked?: true };

export type BlockNode =
	| { type: 'paragraph'; children: InlineNode[] }
	| { type: 'heading'; depth: number; children: InlineNode[] }
	| { type: 'code'; text: string }
	| { type: 'quote'; children: BlockNode[] }
	| { type: 'list'; ordered: boolean; start: number | ''; items: BlockNode[][] }
	| { type: 'rule' }
	| {
			type: 'table';
			label: string;
			header: InlineNode[][];
			rows: InlineNode[][][];
			align: Array<'center' | 'left' | 'right' | null>;
	  }
	| { type: 'text-block'; text: string };

type ParseState = {
	minHeadingDepth: number;
	headingOffset: number;
	lastHeading: string;
	tableLabels: Map<string, number>;
};

/** Only destinations that stay within the current site or use ordinary web/mail links are clickable. */
export function safeMarkdownHref(value: string): string | undefined {
	const href = value.trim();
	if (!href || /[\u0000-\u0020\u007f]/.test(href) || href.startsWith('//') || href.includes('\\'))
		return undefined;
	if (/^(?:https?:|mailto:)/i.test(href)) return href;
	if (href.startsWith('/') && !href.startsWith('//')) return href;
	if (href.startsWith('#')) return href;
	return undefined;
}

/** Computes a descriptive host- or destination-based label when a linked image omits alt text. */
export function imageLinkLabel(href: string): string {
	if (/^mailto:/i.test(href)) {
		const recipient = href.slice(7).split('?')[0]?.trim();
		const domain = recipient?.split('@')[1]?.trim();
		return domain ? `Email link (${domain})` : 'Email link';
	}
	if (href.startsWith('#')) {
		const target = href.slice(1).trim();
		return target ? `Section link (${target})` : 'Section link';
	}
	if (href.startsWith('/')) {
		return 'Open local link';
	}
	try {
		const host = new URL(href).hostname.replace(/^www\./i, '');
		if (host) return `Open media from ${host}`;
	} catch {}
	return 'Open external link';
}

function inlineText(nodes: InlineNode[]): string {
	let text = '';
	for (const node of nodes) {
		if (node.type === 'text' || node.type === 'code') text += node.text;
		else if (node.type === 'break') text += ' ';
		else if (node.type === 'image') text += node.alt;
		else text += inlineText(node.children);
	}
	return text.replace(/\s+/g, ' ').trim();
}

function markInteractiveStacked(node: InlineNode): boolean {
	if (node.type === 'link') {
		node.stacked = true;
		return true;
	}
	if (node.type === 'image' && node.href) {
		node.stacked = true;
		return true;
	}
	if (node.type === 'strong' || node.type === 'em' || node.type === 'del') {
		let markedAny = false;
		for (const child of node.children) {
			if (markInteractiveStacked(child)) markedAny = true;
		}
		return markedAny;
	}
	return false;
}

function containsInteractive(nodes: InlineNode[]): boolean {
	for (const node of nodes) {
		if (node.type === 'link' || (node.type === 'image' && node.href)) return true;
		if (
			(node.type === 'strong' || node.type === 'em' || node.type === 'del') &&
			containsInteractive(node.children)
		)
			return true;
	}
	return false;
}

function isWhitespaceText(node: InlineNode): boolean {
	return node.type === 'text' && node.text.trim() === '';
}

function flagBreakAdjacentLinks(nodes: InlineNode[]): void {
	if (!nodes.some((node) => node.type === 'break')) return;
	for (let i = 0; i < nodes.length; i++) {
		if (nodes[i].type !== 'break') continue;
		for (let left = i - 1; left >= 0; left--) {
			if (isWhitespaceText(nodes[left])) continue;
			markInteractiveStacked(nodes[left]);
			break;
		}
		for (let right = i + 1; right < nodes.length; right++) {
			if (isWhitespaceText(nodes[right])) continue;
			markInteractiveStacked(nodes[right]);
			break;
		}
	}
	const lines: InlineNode[][] = [[]];
	for (const node of nodes) {
		if (node.type === 'break') lines.push([]);
		else lines[lines.length - 1].push(node);
	}
	for (let i = 0; i < lines.length - 1; i++) {
		if (containsInteractive(lines[i]) && containsInteractive(lines[i + 1])) {
			for (const node of lines[i]) markInteractiveStacked(node);
			for (const node of lines[i + 1]) markInteractiveStacked(node);
		}
	}
}

function inline(tokens: Token[] | undefined, fallback = '', insideLink = false): InlineNode[] {
	if (!tokens) return fallback ? [{ type: 'text', text: fallback }] : [];
	const result: InlineNode[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'text':
				if (token.tokens) result.push(...inline(token.tokens, token.text, insideLink));
				else result.push({ type: 'text', text: token.text });
				break;
			case 'escape':
				result.push({ type: 'text', text: token.text });
				break;
			case 'codespan':
				result.push({ type: 'code', text: token.text });
				break;
			case 'br':
				result.push({ type: 'break' });
				break;
			case 'strong':
				result.push({ type: 'strong', children: inline(token.tokens, token.text, insideLink) });
				break;
			case 'em':
				result.push({ type: 'em', children: inline(token.tokens, token.text, insideLink) });
				break;
			case 'del':
				result.push({ type: 'del', children: inline(token.tokens, token.text, insideLink) });
				break;
			case 'link': {
				const href = safeMarkdownHref(token.href);
				const children = inline(token.tokens, token.text, Boolean(href) || insideLink);
				if (href && !insideLink) {
					const content = inlineText(children)
						? children
						: [{ type: 'text' as const, text: imageLinkLabel(href) }];
					result.push({ type: 'link', href, children: content });
				} else {
					result.push(...children);
				}
				break;
			}
			case 'image': {
				const trimmedAlt = token.text.trim();
				const href = insideLink ? undefined : safeMarkdownHref(token.href);
				if (!trimmedAlt) {
					if (href) result.push({ type: 'image', alt: imageLinkLabel(href), href });
				} else {
					result.push({ type: 'image', alt: token.text, href });
				}
				break;
			}
			case 'html':
				result.push({ type: 'text', text: token.raw });
				break;
			default:
				result.push({ type: 'text', text: typeof token.raw === 'string' ? token.raw : '' });
		}
	}
	if (!insideLink) flagBreakAdjacentLinks(result);
	return result;
}

function findMinHeadingDepth(tokens: Token[]): number {
	let min = Infinity;
	for (const token of tokens) {
		if (token.type === 'heading') {
			min = Math.min(min, Math.max(1, token.depth));
		} else if (token.type === 'blockquote' && token.tokens) {
			min = Math.min(min, findMinHeadingDepth(token.tokens));
		} else if (token.type === 'list') {
			for (const item of token.items as Array<{ tokens?: Token[] }>) {
				if (item.tokens) min = Math.min(min, findMinHeadingDepth(item.tokens));
			}
		}
	}
	return min;
}

function uniqueTableLabel(header: InlineNode[][], state: ParseState): string {
	const columns = header
		.map((cell) => inlineText(cell))
		.filter(Boolean)
		.slice(0, 3)
		.join(', ');
	const heading = state.lastHeading;
	let base = '';
	if (heading && columns) {
		base =
			heading.toLowerCase() === columns.toLowerCase()
				? `${heading} table`
				: `${heading}: ${columns} table`;
	} else if (heading) {
		base = /\btable$/i.test(heading) ? heading : `${heading} table`;
	} else if (columns) {
		base = `${columns} table`;
	} else {
		base = 'Data table';
	}
	const count = (state.tableLabels.get(base) ?? 0) + 1;
	state.tableLabels.set(base, count);
	if (base === 'Data table') return `Data table ${count}`;
	return count === 1 ? base : `${base} (${count})`;
}

function blocks(tokens: Token[], state: ParseState): BlockNode[] {
	const result: BlockNode[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'space':
			case 'def':
			case 'checkbox':
				break;
			case 'paragraph':
				result.push({ type: 'paragraph', children: inline(token.tokens, token.text) });
				break;
			case 'text':
				result.push({ type: 'paragraph', children: inline(token.tokens, token.text) });
				break;
			case 'heading': {
				const children = inline(token.tokens, token.text);
				const headingText = inlineText(children);
				if (headingText) state.lastHeading = headingText;
				result.push({
					type: 'heading',
					depth: Math.min(6, Math.max(state.minHeadingDepth, token.depth + state.headingOffset)),
					children
				});
				break;
			}
			case 'code':
				result.push({ type: 'code', text: token.text });
				break;
			case 'blockquote':
				result.push({ type: 'quote', children: blocks(token.tokens ?? [], state) });
				break;
			case 'list':
				result.push({
					type: 'list',
					ordered: token.ordered,
					start: token.start,
					items: token.items.map((item: { tokens?: Token[] }) => blocks(item.tokens ?? [], state))
				});
				break;
			case 'hr':
				result.push({ type: 'rule' });
				break;
			case 'table': {
				const header = token.header.map((cell: { tokens: Token[]; text: string }) =>
					inline(cell.tokens, cell.text)
				);
				result.push({
					type: 'table',
					label: uniqueTableLabel(header, state),
					header,
					rows: token.rows.map((row: Array<{ tokens: Token[]; text: string }>) =>
						row.map((cell) => inline(cell.tokens, cell.text))
					),
					align: token.align
				});
				break;
			}
			case 'html':
				result.push({ type: 'text-block', text: token.raw });
				break;
			default:
				result.push({ type: 'text-block', text: typeof token.raw === 'string' ? token.raw : '' });
		}
	}
	return result;
}

/** Parses Markdown into a small safe AST. Raw HTML is always treated as text. */
export function parseChatMarkdown(
	content: string,
	{ minHeadingDepth = 3 }: { minHeadingDepth?: number } = {}
): BlockNode[] {
	try {
		const tokens = marked.lexer(content, { gfm: true, breaks: true });
		const clampedMin = Math.min(6, Math.max(1, Math.trunc(minHeadingDepth)));
		const shallowest = findMinHeadingDepth(tokens);
		const headingOffset = Number.isFinite(shallowest) ? Math.max(0, clampedMin - shallowest) : 0;
		return blocks(tokens, {
			minHeadingDepth: clampedMin,
			headingOffset,
			lastHeading: '',
			tableLabels: new Map()
		});
	} catch {
		return [{ type: 'text-block', text: content }];
	}
}
