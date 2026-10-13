<!-- A small square preview for admin lists, or a photo/video sign when there is no preview yet. -->
<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Kind } from '#lib/shared/media-types';

	interface Props {
		src: string | null;
		kind: Kind | null;
		alt: string;
	}

	let { src, kind, alt }: Props = $props();
</script>

{#if src}
	<img class="thumb" {src} {alt} width="96" height="96" loading="lazy" decoding="async" />
{:else}
	<span class="thumb none" role="img" aria-label={alt}><Icon name={kind === 'video' ? 'video' : 'photo'} size="2em" /></span>
{/if}

<style>
	.thumb {
		flex: none;
		width: 96px;
		height: 96px;
		border-radius: var(--radius-small);
		background: var(--tile-bg);
		object-fit: cover;
	}
	.none {
		display: grid;
		place-items: center;
		color: var(--muted);
	}
</style>
