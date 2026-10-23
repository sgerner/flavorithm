<script lang="ts">
	let {
		mood = 'idle',
		size = 64,
		active = true
	}: {
		mood?: 'idle' | 'thinking' | 'speaking' | 'pleased' | 'concerned';
		size?: number;
		active?: boolean;
	} = $props();
</script>

<!-- Integer-grid vector pixels stay crisp at every display density. -->
<span
	class="basil-avatar"
	class:active
	data-mood={mood}
	style:width={`${size}px`}
	style:height={`${size}px`}
	aria-hidden="true"
>
	<svg viewBox="0 0 48 48" fill="none" shape-rendering="crispEdges">
		<rect x="2" y="2" width="44" height="44" rx="8" fill="#e7dabb" />
		<path d="M6 38h4v-4h8v-3h12v3h8v4h4v8H6z" fill="#263d39" />
		<path d="M18 33h12l-3 13h-6z" fill="#fff8e6" />
		<path d="M16 34h4l4 7-6-2 2 7h-6zM32 34h-4l-4 7 6-2-2 7h6z" fill="#142925" />
		<path d="M19 34h4v2h2v-2h4v5h-4v-2h-2v2h-4z" fill="#7d3f3a" />
		<rect x="23" y="41" width="2" height="2" fill="#a88b52" />
		<g class="head">
			<path d="M12 13h2V9h4V7h12v2h4v4h2v13h-2v4h-4v3H18v-3h-4v-4h-2z" fill="#e9b98c" />
			<path d="M14 13V9h4V7h12v2h4v4h-4v-2H18v2z" fill="#dbded1" />
			<path d="M12 13h4v9h-2v4h-2zM32 13h4v13h-2v-4h-2z" fill="#f8f1dc" />
			<path d="M16 13h2v-2h4v2h-4v3h-2zM30 11h-4v2h4v3h2v-3h-2z" fill="#b1b8aa" />
			<path class="brow" d="M17 17h5v-2h-5zM27 16h5v-2h-5z" fill="#5a5d51" />
			<g class="eyes" fill="#263d39"><path d="M18 19h3v3h-3zM28 19h3v3h-3z" /></g>
			<path d="M25 22h2v4h-4v-2h2z" fill="#c88766" />
			<path d="M26 18h7v7h-7z" stroke="#aa894d" stroke-width="1" />
			<path d="M33 24v8h2v3" stroke="#aa894d" stroke-width="1" />
			<rect class="mouth" x="21" y="28" width="7" height="1" fill="#663d35" />
			<g class="moustache" fill="#fff4dd"
				><path d="M17 26h5v-1h2v3h-3v1h-4zM24 25h2v1h5v3h-4v-1h-3z" /></g
			>
			<rect x="17" y="24" width="3" height="1" fill="#d89279" /><rect
				x="30"
				y="24"
				width="2"
				height="1"
				fill="#d89279"
			/>
		</g>
		<g class="tea"
			><path d="M34 38h7v5h-7z" fill="#fff8e6" /><path
				d="M41 39h3v3h-3"
				stroke="#fff8e6"
				stroke-width="1"
			/><path d="M32 44h12" stroke="#b79a5c" stroke-width="2" /><path
				class="steam"
				d="M36 35v-3h2v-3M40 35v-4"
				stroke="#fff8e6"
				stroke-width="1"
			/></g
		>
	</svg>
</span>

<style>
	.basil-avatar {
		display: inline-flex;
		flex-shrink: 0;
		vertical-align: middle;
	}
	svg {
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
		overflow: visible;
	}
	.head,
	.eyes,
	.mouth,
	.brow,
	.moustache {
		transform-box: fill-box;
		transform-origin: center;
	}
	.active .eyes {
		animation: blink 6s steps(1) infinite;
	}
	.active .brow {
		animation: eyebrow 9s steps(1) infinite;
	}
	.active .steam {
		animation: steam 3s steps(3) infinite;
	}
	.active[data-mood='thinking'] .head {
		animation: ponder 1.8s steps(2) infinite;
	}
	.active[data-mood='speaking'] .mouth {
		animation: chatter 330ms steps(2) infinite;
	}
	.active[data-mood='speaking'] .moustache {
		animation: whiskers 330ms steps(2) infinite;
	}
	.active[data-mood='speaking'] .head {
		animation: lecture 900ms steps(2) infinite;
	}
	.active[data-mood='pleased'] .head {
		animation: nod 700ms steps(2) 2;
	}
	[data-mood='concerned'] .brow {
		transform: rotate(-9deg);
	}
	@keyframes blink {
		0%,
		44%,
		48%,
		100% {
			transform: scaleY(1);
		}
		45%,
		47% {
			transform: scaleY(0.15);
		}
	}
	@keyframes eyebrow {
		0%,
		78%,
		90%,
		100% {
			transform: translateY(0);
		}
		80%,
		88% {
			transform: translateY(-1px);
		}
	}
	@keyframes steam {
		0%,
		100% {
			opacity: 0.3;
			transform: translateY(0);
		}
		50% {
			opacity: 0.8;
			transform: translateY(-2px);
		}
	}
	@keyframes ponder {
		0%,
		100% {
			transform: rotate(-3deg);
		}
		50% {
			transform: rotate(3deg) translateY(-1px);
		}
	}
	@keyframes chatter {
		0%,
		100% {
			transform: scaleY(1);
		}
		50% {
			transform: scaleY(4);
		}
	}
	@keyframes whiskers {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-1px);
		}
	}
	@keyframes lecture {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-1px);
		}
	}
	@keyframes nod {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(2px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.active :global(*) {
			animation: none !important;
		}
	}
</style>
