import { marked, type Token } from 'marked';

export type InlineNode =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'break' }
	| { type: 'strong' | 'em' | 'del'; children: InlineNode[] }
	| { type: 'link'; href: string; children: InlineNode[] }
	| { type: 'image'; alt: string; href?: string };

export type BlockNode =
	| { type: 'paragraph'; children: InlineNode[] }
	| { type: 'heading'; depth: number; children: InlineNode[] }
	| { type: 'code'; text: string }
	| { type: 'quote'; children: BlockNode[] }
	| { type: 'list'; ordered: boolean; start: number | ''; items: BlockNode[][] }
	| { type: 'rule' }
	| {
			type: 'table';
			header: InlineNode[][];
			rows: InlineNode[][][];
			align: Array<'center' | 'left' | 'right' | null>;
	  }
	| { type: 'text-block'; text: string };

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

function inline(tokens: Token[] | undefined, fallback = ''): InlineNode[] {
	if (!tokens) return fallback ? [{ type: 'text', text: fallback }] : [];
	const result: InlineNode[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'text':
				if (token.tokens) result.push(...inline(token.tokens, token.text));
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
				result.push({ type: 'strong', children: inline(token.tokens, token.text) });
				break;
			case 'em':
				result.push({ type: 'em', children: inline(token.tokens, token.text) });
				break;
			case 'del':
				result.push({ type: 'del', children: inline(token.tokens, token.text) });
				break;
			case 'link': {
				const children = inline(token.tokens, token.text);
				const href = safeMarkdownHref(token.href);
				if (href) result.push({ type: 'link', href, children });
				else result.push(...children);
				break;
			}
			case 'image':
				result.push({ type: 'image', alt: token.text, href: safeMarkdownHref(token.href) });
				break;
			case 'html':
				result.push({ type: 'text', text: token.raw });
				break;
			default:
				result.push({ type: 'text', text: typeof token.raw === 'string' ? token.raw : '' });
		}
	}
	return result;
}

function blocks(tokens: Token[]): BlockNode[] {
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
			case 'heading':
				result.push({
					type: 'heading',
					depth: Math.min(6, Math.max(1, token.depth)),
					children: inline(token.tokens, token.text)
				});
				break;
			case 'code':
				result.push({ type: 'code', text: token.text });
				break;
			case 'blockquote':
				result.push({ type: 'quote', children: blocks(token.tokens ?? []) });
				break;
			case 'list':
				result.push({
					type: 'list',
					ordered: token.ordered,
					start: token.start,
					items: token.items.map((item: { tokens?: Token[] }) => blocks(item.tokens ?? []))
				});
				break;
			case 'hr':
				result.push({ type: 'rule' });
				break;
			case 'table':
				result.push({
					type: 'table',
					header: token.header.map((cell: { tokens: Token[]; text: string }) =>
						inline(cell.tokens, cell.text)
					),
					rows: token.rows.map((row: Array<{ tokens: Token[]; text: string }>) =>
						row.map((cell) => inline(cell.tokens, cell.text))
					),
					align: token.align
				});
				break;
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
export function parseChatMarkdown(content: string): BlockNode[] {
	try {
		return blocks(marked.lexer(content, { gfm: true, breaks: true }));
	} catch {
		return [{ type: 'text-block', text: content }];
	}
}
