<script lang="ts">
	import { parseChatMarkdown, type BlockNode, type InlineNode } from '#lib/chat-markdown.ts';
	let { content }: { content: string } = $props();
	let blocks = $derived(parseChatMarkdown(content));
</script>

{#snippet renderInline(nodes: InlineNode[])}
	{#each nodes as node}
		{#if node.type === 'text'}{node.text}
		{:else if node.type === 'code'}<code>{node.text}</code>
		{:else if node.type === 'break'}<br />
		{:else if node.type === 'strong'}<strong>{@render renderInline(node.children)}</strong>
		{:else if node.type === 'em'}<em>{@render renderInline(node.children)}</em>
		{:else if node.type === 'del'}<del>{@render renderInline(node.children)}</del>
		{:else if node.type === 'link'}<a href={node.href} target="_blank" rel="noopener noreferrer"
				><span>{@render renderInline(node.children)}</span></a
			>
		{:else if node.type === 'image'}
			{#if node.href}<a
					href={node.href}
					target="_blank"
					rel="noopener noreferrer"
					class="image-link">{node.alt || 'Image'}</a
				>
			{:else}<span class="image-alt">{node.alt || 'Image'}</span>{/if}
		{/if}
	{/each}
{/snippet}

{#snippet renderBlocks(nodes: BlockNode[])}
	{#each nodes as node}
		{#if node.type === 'paragraph'}<p>{@render renderInline(node.children)}</p>
		{:else if node.type === 'heading'}
			<svelte:element this={`h${node.depth}`}>{@render renderInline(node.children)}</svelte:element>
		{:else if node.type === 'code'}<pre><code>{node.text}</code></pre>
		{:else if node.type === 'quote'}<blockquote>{@render renderBlocks(node.children)}</blockquote>
		{:else if node.type === 'list'}
			{#if node.ordered}<ol start={node.start || undefined}>
					{#each node.items as item}<li>{@render renderBlocks(item)}</li>{/each}
				</ol>{:else}<ul>
					{#each node.items as item}<li>{@render renderBlocks(item)}</li>{/each}
				</ul>{/if}
		{:else if node.type === 'rule'}<hr />
		{:else if node.type === 'table'}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable tables need keyboard focus.) -->
			<div class="table-scroll" tabindex="0" role="region" aria-label="Markdown table">
				<table>
					<thead
						><tr
							>{#each node.header as cell, i}<th style:text-align={node.align[i] ?? undefined}
									>{@render renderInline(cell)}</th
								>{/each}</tr
						></thead
					>
					<tbody
						>{#each node.rows as row}<tr
								>{#each row as cell, i}<td style:text-align={node.align[i] ?? undefined}
										>{@render renderInline(cell)}</td
									>{/each}</tr
							>{/each}</tbody
					>
				</table>
			</div>
		{:else if node.type === 'text-block'}<p>{node.text}</p>
		{/if}
	{/each}
{/snippet}

<div class="chat-markdown">{@render renderBlocks(blocks)}</div>

<style>
	.chat-markdown {
		min-width: 0;
		overflow-wrap: anywhere;
		line-height: 1.6;
		font-size: 13px;
	}
	.chat-markdown :global(p) {
		margin: 0.35em 0;
	}
	.chat-markdown :global(p:first-child) {
		margin-top: 0;
	}
	.chat-markdown :global(p:last-child) {
		margin-bottom: 0;
	}
	.chat-markdown :global(h1),
	.chat-markdown :global(h2),
	.chat-markdown :global(h3),
	.chat-markdown :global(h4),
	.chat-markdown :global(h5),
	.chat-markdown :global(h6) {
		margin: 0.75em 0 0.3em;
		font-size: 1em;
		line-height: 1.3;
		font-weight: 700;
	}
	.chat-markdown :global(ul),
	.chat-markdown :global(ol) {
		margin: 0.4em 0;
		padding-left: 1.5em;
	}
	.chat-markdown :global(ul) {
		list-style-type: disc;
	}
	.chat-markdown :global(ol) {
		list-style-type: decimal;
	}
	.chat-markdown :global(strong) {
		font-weight: 700;
	}
	.chat-markdown :global(li + li) {
		margin-top: 0.15em;
	}
	.chat-markdown :global(blockquote) {
		margin: 0.5em 0;
		padding: 0.15em 0 0.15em 0.75em;
		border-left: 2px solid var(--line, #bbb);
		opacity: 0.9;
	}
	.chat-markdown :global(code) {
		padding: 0.08em 0.28em;
		border-radius: 0.25em;
		background: color-mix(in srgb, currentColor 9%, transparent);
		font-size: 0.92em;
	}
	.chat-markdown :global(pre) {
		max-width: 100%;
		overflow-x: auto;
		margin: 0.5em 0;
		padding: 0.65em 0.75em;
		border-radius: 0.45em;
		background: color-mix(in srgb, currentColor 7%, transparent);
		white-space: pre;
	}
	.chat-markdown :global(pre code) {
		padding: 0;
		background: transparent;
	}
	.chat-markdown :global(a) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.table-scroll {
		max-width: 100%;
		overflow-x: auto;
		margin: 0.5em 0;
	}
	.chat-markdown :global(table) {
		border-collapse: collapse;
		min-width: 100%;
		font-size: 0.92em;
	}
	.chat-markdown :global(th),
	.chat-markdown :global(td) {
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		padding: 0.3em 0.5em;
	}
	.chat-markdown :global(hr) {
		margin: 0.7em 0;
		border: 0;
		border-top: 1px solid color-mix(in srgb, currentColor 22%, transparent);
	}
	.image-alt,
	.image-link {
		font-style: italic;
		opacity: 0.85;
	}
</style>
